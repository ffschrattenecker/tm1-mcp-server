// Live test harness — drives the REAL MCP tool layer against a running TM1
// server, exactly as an MCP client would: each call goes through the tool's
// zod input schema (defaults + validation), the withAnnotations wrapper
// (annotation injection, error normalization, outputSchema attach), and the
// real handler → real TM1Client → real OData. This is end-to-end coverage of
// the tool surface, not unit mocks.
//
// Opt-in: requires TM1_BASE_URL + TM1_USER in the environment (loaded from
// .env via dotenv). When absent, LIVE_ENABLED is false and suites skip.
//
// Everything this harness creates lives under the SANDBOX prefix so a stray
// run can never touch real model objects, and sweepSandbox() removes leftovers.
import "dotenv/config";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type TM1Config } from "../../src/config.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";
import { createLogger } from "../../src/logger.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { RECORDING } from "./contract-mode.js";
import { recordingClient } from "./service-recorder.js";
import { registerAllTools } from "../../src/tools/index.js";
import type { McpToolResult } from "../../src/tools/error-format.js";
import type { TestContext } from "vitest";

/** True only when the environment is configured to reach a live TM1 server. */
export const LIVE_ENABLED = Boolean(
  process.env.TM1_BASE_URL && process.env.TM1_USER,
);

/** All objects this harness creates are prefixed with this. Never collides
 *  with real model objects; sweepSandbox() keys off it. */
export const SANDBOX = "ZZ_MCP_LIVE";

/** Result of a single tool invocation, normalized for assertions. */
export interface CallResult {
  /** Raw MCP tool result (content[], isError, structuredContent, …). */
  result: McpToolResult;
  /** Parsed JSON from the first text block, if it was JSON. */
  json: any;
  /** Raw first text block. */
  text: string | undefined;
  /** True when the tool returned an error envelope (handler threw or isError). */
  isError: boolean;
}

interface ToolEntry {
  inputSchema: ZodRawShape;
  handler: (...args: unknown[]) => Promise<McpToolResult>;
}

export interface LiveHarness {
  client: TM1Client;
  /** Invoke a tool by name with raw args, as an MCP client would. */
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Like call(), but throws if the tool returned an error envelope. */
  ok: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Names of all registered (readwrite-mode) tools. */
  toolNames: () => string[];
  /** True when a tool is registered for the connected server version.
   *  Version-gated tools (v11-only logs/threads, v12-only jobs) are absent by
   *  design on the other version — see `enabled:` in their defineTool spec. */
  has: (name: string) => boolean;
}

let harnessPromise: Promise<LiveHarness> | null = null;

// Minimal RequestHandlerExtra stand-in. Tool handlers destructure only their
// args object and ignore `extra`, so a stub satisfies the call signature.
const mockExtra = {
  signal: new AbortController().signal,
  requestId: "live-harness",
  sendNotification: async () => undefined,
  sendRequest: async () => undefined,
};

/**
 * Connect once, register every tool in readwrite mode (so destructive tools
 * are available for lifecycle teardown), and return a shared harness. Safe to
 * call from multiple beforeAll hooks — the connection is memoized.
 */
export function getHarness(): Promise<LiveHarness> {
  harnessPromise ??= build();
  return harnessPromise;
}

async function build(): Promise<LiveHarness> {
  const baseConfig = loadConfig();
  // Force readwrite: lifecycle suites must create AND delete sandbox objects.
  const config: TM1Config = { ...baseConfig, mode: "readwrite" };
  const logger = createLogger({ logLevel: "error" });
  const sessionManager = new SessionManager(config, logger);
  const realClient = new TM1Client(config, sessionManager, logger);
  await realClient.connect();
  // While recording, tools run against a transparent proxy that notes the
  // shape each service method returns — the layer the client-level unit fakes
  // stand in for. Identical behaviour otherwise.
  const client = RECORDING ? recordingClient(realClient) : realClient;

  // Fake McpServer: capture the fully-wrapped (annotation + error-normalized)
  // handlers that withAnnotations registers via registerTool.
  const registry = new Map<string, ToolEntry>();
  const fakeServer = {
    registerTool(
      name: string,
      cfg: { inputSchema?: ZodRawShape },
      cb: (...args: unknown[]) => Promise<McpToolResult>,
    ) {
      registry.set(name, { inputSchema: cfg.inputSchema ?? {}, handler: cb });
    },
    // Two things reach through to the low-level server:
    //   sendLoggingMessage — wrapCb's slow-tool warnings
    //   setRequestHandler  — installToolsListSlimming wraps the tools/list
    //                        handler here. This harness calls tools straight
    //                        out of `registry` and never issues tools/list, so
    //                        a no-op suffices; it only has to exist, or
    //                        withAnnotations throws on `.bind`.
    server: {
      sendLoggingMessage: async () => undefined,
      setRequestHandler: () => undefined,
    },
  } as unknown as McpServer;

  registerAllTools(withAnnotations(fakeServer, logger, "readwrite"), client);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallResult> => {
    const entry = registry.get(name);
    if (!entry) {
      throw new Error(
        `Tool not registered: ${name} (typo, or missing from ANNOTATION_MAP?)`,
      );
    }
    // Parse through the tool's own schema — applies defaults and validation
    // exactly as the MCP SDK does before dispatching to the handler.
    const parsed = z.object(entry.inputSchema).parse(args);
    const result = await entry.handler(parsed, mockExtra);
    const first = result?.content?.[0];
    const text =
      first && first.type === "text" && typeof first.text === "string"
        ? first.text
        : undefined;
    let json: unknown;
    if (text) {
      const t = text.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          json = JSON.parse(t);
        } catch {
          /* non-JSON text result (e.g. table format) */
        }
      }
    }
    return { result, json, text, isError: Boolean(result?.isError) };
  };

  const ok = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallResult> => {
    const r = await call(name, args);
    if (r.isError) {
      throw new Error(
        `Expected ${name} to succeed but got error: ${r.text ?? "(no body)"}`,
      );
    }
    return r;
  };

  return {
    client,
    call,
    ok,
    toolNames: () => [...registry.keys()],
    has: (name: string) => registry.has(name),
  };
}

/**
 * Skip the current test when a version-gated tool is not registered on the
 * target server.
 *
 * A tool the version gate deliberately withholds must read as **skipped**, not
 * failed. Before this existed, a v12 run reported seven red tests that were
 * working exactly as designed — and a real v12 regression would have been
 * indistinguishable from that noise. The gate itself is asserted positively in
 * ops.live.test.ts, so skipping here loses no coverage.
 */
export function skipUnlessRegistered(
  ctx: TestContext,
  h: LiveHarness,
  ...names: string[]
): void {
  const missing = names.filter((n) => !h.has(n));
  if (missing.length > 0) {
    ctx.skip(
      `version-gated off on this server (v${h.client.version}): ${missing.join(", ")}`,
    );
  }
}

/**
 * A raw REST call for fixtures no tool covers (e.g. TM1 sandboxes). The
 * transport is private on TM1Client by design; tests reach it deliberately.
 */
export function rawRequest<T = unknown>(
  h: LiveHarness,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const http = (
    h.client as unknown as {
      http: { request: (m: string, p: string, b?: unknown) => Promise<T> };
    }
  ).http;
  return http.request(method, path, body);
}

// ── REST fixtures ────────────────────────────────────────────────────────────
// Setup and teardown go through tm1_rest_read / tm1_rest_write, the tools that
// replaced the per-object CRUD tools, so every suite exercises them too.

/** An OData key literal: single quotes doubled. */
export const key = (name: string): string => name.replace(/'/g, "''");

/** A path segment `Coll('name')` with the name OData-quoted and URL-encoded. */
export const seg = (coll: string, name: string): string =>
  `${coll}('${encodeURIComponent(key(name))}')`;

/** GET through tm1_rest_read; returns `data` (collections: the value[] array). */
export async function restGet<T = any>(
  h: LiveHarness,
  path: string,
): Promise<T> {
  const r = await h.ok("tm1_rest_read", { path });
  const data = r.json?.data;
  return (
    data && typeof data === "object" && "value" in data ? data.value : data
  ) as T;
}

/** POST/PATCH/PUT/DELETE through tm1_rest_write. `confirm` defaults to the last key. */
export async function restWrite(
  h: LiveHarness,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  confirm?: string,
): Promise<CallResult> {
  const last = [...path.matchAll(/\('((?:[^']|'')*)'\)|\((\d+)\)/g)].pop();
  const target =
    confirm ??
    (last
      ? decodeURIComponent(last[1] ?? last[2]!).replace(/''/g, "'")
      : undefined);
  return h.ok("tm1_rest_write", {
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(target === undefined ? {} : { confirm: target }),
  });
}

/** Names in a collection, e.g. names(h, "Cubes", SANDBOX) — `contains` filter. */
export async function names(
  h: LiveHarness,
  collection: string,
  contains?: string,
): Promise<string[]> {
  const filter = contains ? `&$filter=contains(Name,'${key(contains)}')` : "";
  const rows = await restGet<Array<{ Name: string }>>(
    h,
    `${collection}?$select=Name${filter}`,
  );
  return rows.map((r) => r.Name);
}

export interface ElementSpec {
  name: string;
  type?: "Numeric" | "String" | "Consolidated";
  /** Children of a consolidation, weight 1 unless given. */
  children?: Array<string | { name: string; weight: number }>;
}

/** Create a dimension with a same-named hierarchy and these elements. */
export async function createDimension(
  h: LiveHarness,
  name: string,
  elements: Array<string | ElementSpec> = [],
): Promise<void> {
  const specs = elements.map((e) => (typeof e === "string" ? { name: e } : e));
  const edges = specs.flatMap((p) =>
    (p.children ?? []).map((c) => ({
      ParentName: p.name,
      ComponentName: typeof c === "string" ? c : c.name,
      Weight: typeof c === "string" ? 1 : c.weight,
    })),
  );
  await restWrite(h, "POST", "Dimensions", {
    Name: name,
    Hierarchies: [
      {
        Name: name,
        Elements: specs.map((e) => ({
          Name: e.name,
          Type: e.type ?? (e.children?.length ? "Consolidated" : "Numeric"),
        })),
        ...(edges.length ? { Edges: edges } : {}),
      },
    ],
  });
}

/** Create a cube over existing dimensions (rules: use tm1_set_cube_rules). */
export async function createCube(
  h: LiveHarness,
  name: string,
  dimensions: string[],
): Promise<void> {
  await restWrite(h, "POST", "Cubes", {
    Name: name,
    "Dimensions@odata.bind": dimensions.map((d) => seg("Dimensions", d)),
  });
}

/** DELETE `path`, ignoring an object that is already gone. */
export async function dropIfExists(
  h: LiveHarness,
  path: string,
): Promise<void> {
  try {
    await restWrite(h, "DELETE", path);
  } catch (e) {
    if (!/NOT_FOUND|404|not found/i.test((e as Error).message)) throw e;
  }
}

const mdxName = (n: string) => n.replace(/]/g, "]]");

/** One cell's value, read with tm1_execute_mdx. */
export async function cellValue(
  h: LiveHarness,
  cube: string,
  dimensions: string[],
  elements: string[],
): Promise<unknown> {
  const tuple = elements
    .map((e, i) => {
      const d = mdxName(dimensions[i]!);
      return `[${d}].[${d}].[${mdxName(e)}]`;
    })
    .join(",");
  const r = await h.ok("tm1_execute_mdx", {
    mdx: `SELECT {(${tuple})} ON 0 FROM [${mdxName(cube)}]`,
  });
  return r.json.cells[0]?.value ?? null;
}

/**
 * Best-effort teardown: delete any sandbox-prefixed objects left behind by a
 * crashed or interrupted suite. Idempotent — missing objects are ignored.
 */
export async function sweepSandbox(h: LiveHarness): Promise<void> {
  const swallow = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch {
      /* already gone */
    }
  };

  // Deletion order follows dependencies: chores reference processes; cubes
  // reference dimensions (and own their views). Delete dependents first so a
  // bound object never blocks its dependency's removal.

  // 1. Chores (free the processes they bind).
  for (const n of await names(h, "Chores", SANDBOX)) {
    await swallow(restWrite(h, "DELETE", seg("Chores", n)));
  }

  // 2. Processes.
  for (const n of await names(h, "Processes", SANDBOX)) {
    await swallow(restWrite(h, "DELETE", seg("Processes", n)));
  }

  // 2b. TM1 sandboxes. One left behind with IncludeInSandboxDimension=true is
  // a member of the shared Sandboxes dimension of every cube on the server.
  try {
    for (const n of await names(h, "Sandboxes", SANDBOX)) {
      await swallow(restWrite(h, "DELETE", seg("Sandboxes", n)));
    }
  } catch {
    /* sandboxing disabled on this server */
  }

  // 3. Cubes (drops their views with them; frees the dimensions). `contains`
  // also catches sandbox control cubes (}ElementAttributes_…, }Views_…).
  for (const n of await names(h, "Cubes", SANDBOX)) {
    await swallow(restWrite(h, "DELETE", seg("Cubes", n)));
  }

  // 4. Dimensions (now unreferenced). Base dimensions first, then control
  // dimensions (}Subsets_… lingers after its base dim on TM1 11.8).
  const dimNames = await names(h, "Dimensions", SANDBOX);
  for (const n of dimNames.filter((d) => !d.startsWith("}"))) {
    await swallow(restWrite(h, "DELETE", seg("Dimensions", n)));
  }
  for (const n of dimNames.filter((d) => d.startsWith("}"))) {
    await swallow(restWrite(h, "DELETE", seg("Dimensions", n)));
  }
}
