// Single-site tool definition.
//
// A tool's metadata (title, annotations, output schema, markdown support) lives
// in one defineTool() literal next to its handler. defineTool stores the spec
// and then registers through `server.tool(name, description, input, cb)`, the
// call the Proxy in ./with-annotations.ts intercepts. The Proxy reads the spec
// with `specFor`.
//
// Derived from the shapes, so they cannot drift:
//   - markdown capability: an input shape carrying `format` (i.e. one that
//     spread FORMAT_SCHEMA) gets `markdownCapable()` applied to its output
//     schema automatically.
//   - passthrough handling: a full ZodObject output is routed through
//     `asOutputSchema()`, so `.passthrough()` / `.catchall()` schemas keep
//     `additionalProperties: true` without the caller remembering the helper.
import type {
  McpServer,
  ToolCallback,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import type { TM1Client } from "../tm1-client.js";
import { ConnectionRegistry } from "../connections.js";
import { TM1Error, TM1ErrorCode } from "../types.js";
import type { Tm1ToolAnnotations } from "./annotations.js";
import { asOutputSchema } from "./schemas/output-schema.js";
import { markdownCapable } from "./schemas/markdown-capable.js";
import type { McpToolResult } from "./error-format.js";

/**
 * Where a tool gets its client from: the multi-connection registry in
 * production, or one prebuilt client (unit tests, embedders), which is wrapped
 * as a single-connection registry.
 */
export type ClientSource = TM1Client | ConnectionRegistry;

/** Registrar shape expected by the REGISTRARS array in ./index.ts. */
export type ToolRegistrar = (server: McpServer, source: ClientSource) => void;

export function asRegistry(source: ClientSource): ConnectionRegistry {
  return source instanceof ConnectionRegistry
    ? source
    : ConnectionRegistry.single(source);
}

function registerOnServer(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  cb: unknown,
): void {
  (
    server.registerTool as unknown as (
      n: string,
      cfg: { description: string; inputSchema: ZodRawShape },
      fn: unknown,
    ) => unknown
  )(name, { description, inputSchema }, cb);
}

interface ToolSpecBase<I extends ZodRawShape> {
  /** Wire name, `tm1_*`. */
  name: string;
  /**
   * Tool description. An array is joined with a single space — the same shape
   * the hand-written registrations use, and what scripts/lib/scan-tools.mjs
   * parses for docs/TOOLS.md.
   */
  description: string | readonly string[];
  /** Zod raw shape for the tool's arguments. */
  input: I;
  /**
   * Output payload schema, pre-widening. Pass the plain schema or raw shape;
   * `asOutputSchema()` and `markdownCapable()` are applied here as needed.
   * Omit for tools that answer with unstructured text.
   */
  output?: ZodObject<ZodRawShape> | ZodRawShape;
  /** MCP behavior hints — one of the presets in ./annotations.js. */
  annotations: Tm1ToolAnnotations;
  /**
   * Gate for tools that exist on one TM1 generation only (v11 threads vs v12
   * jobs, v11-only save_data). The tool is registered only when at least one
   * connection runs that version, and a call against a connection on the other
   * version is refused. This is deliberately separate from the
   * `requiresVersion` annotation, which is a client-facing HINT and is also
   * carried by tools that stay registered on both generations.
   */
  version?: 11 | 12;
  /**
   * Writes only into a sandbox under TM1_MODE=sandbox; the tool itself enforces
   * the prefix. Lets a sandbox connection call a write tool that is otherwise
   * refused, and lets the server list it in sandbox mode.
   */
  sandboxScoped?: boolean;
  /**
   * MCP Tasks extension support (`execution.taskSupport`). Enabled for
   * long-running TI/chore executions backed by TM1 `/_async('id')`.
   */
  taskSupport?: "optional" | "required";
  /**
   * Optional domain keywords / jargon terms indexed for `TM1_TOOL_DISCOVERY=search`.
   */
  keywords?: readonly string[];
  /**
   * Runtime gate, asked on every call against the connection it targets: the
   * reason the tool cannot be used there now, or undefined. It may read what
   * TM1 reports after login (`tm1Client.sandboxingDisabled`), which is unknown
   * when the tools are registered. The tool stays listed: a call answers with
   * the reason, because clients are lazy and there are several connections.
   */
  unavailable?: (tm1Client: TM1Client) => string | undefined;
}

type ToolArgsOf<I extends ZodRawShape> = z.infer<z.ZodObject<I>>;
type ToolHandlerResult = McpToolResult | Promise<McpToolResult>;

/** A tool that acts on one TM1 connection — every tool but a handful. */
interface ConnectionToolSpec<I extends ZodRawShape> extends ToolSpecBase<I> {
  connectionless?: false;
  peer?: false;
  /**
   * Handler. Receives the parsed args, the client of the connection the call
   * targets, and the SDK's per-call ServerContext (abort signal, request metadata).
   */
  handler: (
    args: ToolArgsOf<I>,
    tm1Client: TM1Client,
    extra: ServerContext,
  ) => ToolHandlerResult;
}

/**
 * A tool about the connections themselves (tm1_list_connections): it takes no
 * `connection` argument and gets the registry instead of a client, so calling
 * it never logs in anywhere.
 */
interface ConnectionlessToolSpec<
  I extends ZodRawShape,
> extends ToolSpecBase<I> {
  connectionless: true;
  peer?: false;
  handler: (
    args: ToolArgsOf<I>,
    registry: ConnectionRegistry,
    extra: ServerContext,
  ) => ToolHandlerResult;
}

/** One side of a two-connection comparison. */
interface PeerSide {
  /** Resolved connection name (the only one when the server has just one). */
  name: string;
  client: TM1Client;
}

/**
 * A read-only tool that compares two connections (DEV vs PROD). Besides
 * `connection` it takes an optional `connectionB` that defaults to
 * `connection`, so every such tool also works on a single server (comparing
 * two objects on it).
 */
interface PeerToolSpec<I extends ZodRawShape> extends ToolSpecBase<I> {
  connectionless?: false;
  peer: true;
  handler: (
    args: ToolArgsOf<I>,
    sides: { a: PeerSide; b: PeerSide },
    extra: ServerContext,
  ) => ToolHandlerResult;
}

export type ToolSpec<I extends ZodRawShape> =
  ConnectionToolSpec<I> | ConnectionlessToolSpec<I> | PeerToolSpec<I>;

/** What ./with-annotations.ts and ./compiled-surface.ts need at registration time. */
export interface ResolvedSpec {
  name: string;
  annotations: Tm1ToolAnnotations;
  /** Already widened — hand straight to the SDK. */
  outputSchema?: ZodRawShape | ZodTypeAny;
  /** See ToolSpecBase.sandboxScoped. */
  sandboxScoped: boolean;
  /** See ToolSpecBase.taskSupport. */
  taskSupport?: "optional" | "required";
  /** See ToolSpecBase.keywords. */
  keywords?: readonly string[];
}

// Populated at module-load time, when a tool file's top-level defineTool()
// call runs. That is strictly before registerAllTools() executes, because the
// import graph resolves first — so the Proxy always finds the spec.
const SPECS = new Map<string, ResolvedSpec>();

export function specFor(name: string): ResolvedSpec | undefined {
  return SPECS.get(name);
}

/** Every spec defined so far. Used by the lint gates and by tests. */
export function allSpecs(): ReadonlyMap<string, ResolvedSpec> {
  return SPECS;
}

function isZodObject(
  output: ZodObject<ZodRawShape> | ZodRawShape,
): output is ZodObject<ZodRawShape> {
  return "_def" in output;
}

function resolveOutput(
  output: ZodObject<ZodRawShape> | ZodRawShape | undefined,
  formatCapable: boolean,
): ZodRawShape | ZodTypeAny | undefined {
  if (output === undefined) return undefined;
  const normalized = isZodObject(output) ? asOutputSchema(output) : output;
  return formatCapable ? markdownCapable(normalized) : normalized;
}

export function defineTool<I extends ZodRawShape>(
  spec: ToolSpec<I>,
): ToolRegistrar {
  const description = Array.isArray(spec.description)
    ? spec.description.join(" ")
    : (spec.description as string);

  if ("peer" in spec && spec.peer && !spec.annotations.readOnlyHint) {
    // connectionB escapes the per-call readonly gate below, so only tools that
    // never write may take it.
    throw new Error(
      `defineTool: "${spec.name}" takes a peer connection and must be READ_ONLY.`,
    );
  }

  const existing = SPECS.get(spec.name);
  if (existing) {
    throw new Error(
      `defineTool: duplicate tool name "${spec.name}" — each tool may be defined once.`,
    );
  }

  const outputSchema = resolveOutput(spec.output, "format" in spec.input);
  SPECS.set(spec.name, {
    name: spec.name,
    annotations: spec.annotations,
    sandboxScoped: spec.sandboxScoped === true,
    ...(spec.taskSupport !== undefined
      ? { taskSupport: spec.taskSupport }
      : {}),
    ...(spec.keywords !== undefined ? { keywords: spec.keywords } : {}),
    // Built conditionally: exactOptionalPropertyTypes rejects an explicit
    // `outputSchema: undefined` for an optional property.
    ...(outputSchema === undefined ? {} : { outputSchema }),
  });

  return (server, source) => {
    const registry = asRegistry(source);
    if (spec.connectionless) {
      const handler = spec.handler;
      const cb = ((args: ToolArgsOf<I>, extra: ServerContext) =>
        handler(args, registry, extra)) as unknown as ToolCallback;
      registerOnServer(server, spec.name, description, spec.input, cb);
      return;
    }
    // An empty registry (no connection yet) lists every tool: connections
    // may appear later (registry.refresh) and the tool list is fixed at
    // startup. Mode and version are then enforced per call by gate().
    const empty = registry.usableNames.length === 0;
    if (
      !empty &&
      spec.version !== undefined &&
      !registry.hasVersion(spec.version)
    ) {
      return;
    }
    // Keep `connection` as a dynamic string (not a static z.enum) so folders
    // added after startup via registry.refresh() are accepted by input validation
    // instead of failing before the handler can rescan. Currently configured
    // names are surfaced in the description for model discoverability.
    const names = registry.usableNames;
    const connectionSchema = z.string().min(1);
    const knownList =
      names.length > 0
        ? ` (configured: ${names.join(", ")}; call tm1_list_connections for newly added ones)`
        : "";
    const peerConnection = connectionSchema
      .optional()
      .describe(
        `Second connection to compare against${knownList}. Default: the same as connection.`,
      );
    const input = registry.isSingle
      ? {
          ...spec.input,
          connection: connectionSchema
            .optional()
            .describe(
              `Target TM1 connection (optional: there is only one${names[0] ? `, "${names[0]}"` : ""}).`,
            ),
          ...(spec.peer ? { connectionB: peerConnection } : {}),
        }
      : {
          ...spec.input,
          connection: connectionSchema.describe(
            `Target TM1 connection${knownList}.`,
          ),
          ...(spec.peer ? { connectionB: peerConnection } : {}),
        };
    const gate = (connection: string | undefined) => {
      const info = registry.resolveInfo(connection);
      if (!spec.annotations.readOnlyHint && info.mode === "readonly") {
        throw new TM1Error({
          code: TM1ErrorCode.PERMISSION_DENIED,
          message: `${spec.name} changes TM1, but connection "${info.name}" is readonly.`,
          hint:
            info.modeReason ??
            "Set TM1_MODE=readwrite in that connection's .env to allow writes.",
        });
      }
      if (
        !spec.annotations.readOnlyHint &&
        info.mode === "sandbox" &&
        !spec.sandboxScoped
      ) {
        throw new TM1Error({
          code: TM1ErrorCode.PERMISSION_DENIED,
          message: `${spec.name} changes TM1 outside a sandbox, but connection "${info.name}" is in sandbox mode.`,
          hint:
            info.modeReason ??
            "Set TM1_MODE=readwrite in that connection's .env to allow writes outside sandboxes.",
        });
      }
      if (spec.version !== undefined && info.version !== spec.version) {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `${spec.name} needs TM1 v${spec.version}; connection "${info.name}" is v${info.version}.`,
          hint: `Pick a v${spec.version} connection, or use the v${info.version} equivalent.`,
        });
      }
      return info;
    };
    if (spec.peer) {
      const handler = spec.handler;
      const cb = (async (
        args: ToolArgsOf<I> & {
          connection?: string;
          connectionB?: string;
        },
        extra: ServerContext,
      ) => {
        const { connection, connectionB, ...rest } = args;
        const infoA = gate(connection);
        const infoB = gate(connectionB ?? connection);
        const [clientA, clientB] = await Promise.all([
          registry.get(infoA.name),
          registry.get(infoB.name),
        ]);
        return handler(
          rest as unknown as ToolArgsOf<I>,
          {
            a: { name: infoA.name, client: clientA },
            b: { name: infoB.name, client: clientB },
          },
          extra,
        );
      }) as unknown as ToolCallback;
      registerOnServer(server, spec.name, description, input, cb);
      return;
    }
    const handler = spec.handler;
    const cb = (async (
      args: ToolArgsOf<I> & { connection?: string },
      extra: ServerContext,
    ) => {
      const { connection, ...rest } = args;
      const info = gate(connection);
      const tm1Client = await registry.get(connection);
      const reason = spec.unavailable?.(tm1Client);
      if (reason !== undefined) {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `${spec.name} is unavailable on connection "${info.name}": ${reason}`,
          hint: "Retrying cannot succeed until the cause named in the message is fixed.",
        });
      }
      return handler(rest as unknown as ToolArgsOf<I>, tm1Client, extra);
    }) as unknown as ToolCallback;
    registerOnServer(server, spec.name, description, input, cb);
  };
}
