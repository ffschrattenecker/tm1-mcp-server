// Single-site tool definition.
//
// Historically a tool's metadata lived in four places: the `server.tool(...)`
// call in its own file, an entry in ANNOTATION_MAP, an entry in
// OUTPUT_SCHEMA_MAP, and (for format-capable tools) a name in
// MARKDOWN_CAPABLE_TOOLS. Four of the repo's lint gates exist only to keep
// those name-keyed maps in step with the registrations. `defineTool` collapses
// the four into one literal at the definition site; the maps become fallbacks
// for the not-yet-migrated tools and shrink to nothing as migration proceeds.
//
// Migration is file-by-file on purpose. A `defineTool` tool still registers
// through the same `server.tool(name, description, input, cb)` call the Proxy
// in ./with-annotations.ts intercepts — nothing about the wrapping, error
// normalization, readonly filtering or structuredContent handling changes.
// The Proxy simply looks the spec up here first (see `specFor`) and falls back
// to the maps when there is none.
//
// Two things the maps required by hand are now DERIVED and can no longer drift:
//   - markdown capability: an input shape carrying `format` (i.e. one that
//     spread FORMAT_SCHEMA) gets `markdownCapable()` applied to its output
//     schema automatically — no MARKDOWN_CAPABLE_TOOLS membership to forget.
//   - passthrough handling: a full ZodObject output is routed through
//     `asOutputSchema()`, so `.passthrough()` / `.catchall()` schemas keep
//     `additionalProperties: true` without the caller remembering the helper.
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import type { TM1Client } from "../tm1-client.js";
import { ConnectionRegistry } from "../connections.js";
import { TM1Error, TM1ErrorCode } from "../types.js";
import type { Tm1ToolAnnotations } from "./annotations.js";
import { asOutputSchema } from "./schemas/output-schema.js";
import { markdownCapable } from "./schemas/markdown-capable.js";

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
}

/** A tool that acts on one TM1 connection — every tool but a handful. */
interface ConnectionToolSpec<I extends ZodRawShape> extends ToolSpecBase<I> {
  connectionless?: false;
  /**
   * Handler. Receives the parsed args, the client of the connection the call
   * targets, and the SDK's per-call extra (abort signal, request metadata).
   */
  handler: (
    args: Parameters<ToolCallback<I>>[0],
    tm1Client: TM1Client,
    extra: Parameters<ToolCallback<I>>[1],
  ) => ReturnType<ToolCallback<I>>;
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
  handler: (
    args: Parameters<ToolCallback<I>>[0],
    registry: ConnectionRegistry,
    extra: Parameters<ToolCallback<I>>[1],
  ) => ReturnType<ToolCallback<I>>;
}

export type ToolSpec<I extends ZodRawShape> =
  ConnectionToolSpec<I> | ConnectionlessToolSpec<I>;

/** What ./with-annotations.ts needs at registration time. */
export interface ResolvedSpec {
  name: string;
  annotations: Tm1ToolAnnotations;
  /** Already widened — hand straight to the SDK. */
  outputSchema?: ZodRawShape | ZodTypeAny;
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
    // Built conditionally: exactOptionalPropertyTypes rejects an explicit
    // `outputSchema: undefined` for an optional property.
    ...(outputSchema === undefined ? {} : { outputSchema }),
  });

  return (server, source) => {
    const registry = asRegistry(source);
    if (spec.connectionless) {
      const handler = spec.handler;
      const cb = ((
        args: Parameters<ToolCallback<I>>[0],
        extra: Parameters<ToolCallback<I>>[1],
      ) => handler(args, registry, extra)) as unknown as ToolCallback<I>;
      server.tool(spec.name, description, spec.input, cb);
      return;
    }
    const handler = spec.handler;
    if (spec.version !== undefined && !registry.hasVersion(spec.version)) {
      return;
    }
    // One connection: the input shape is exactly what the tool declares. More
    // than one: every tool takes a `connection` naming the target.
    const input = registry.isSingle
      ? spec.input
      : {
          ...spec.input,
          connection: z
            .enum(registry.usableNames as [string, ...string[]])
            .describe("Target TM1 connection."),
        };
    // ToolCallback<I> is a conditional type over an unresolved generic, so TS
    // cannot check the lambda against it — the cast asserts what the
    // ToolSpec.handler signature already pins down (same args, same return).
    const cb = (async (
      args: Parameters<ToolCallback<I>>[0] & { connection?: string },
      extra: Parameters<ToolCallback<I>>[1],
    ) => {
      const { connection, ...rest } = args;
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
      if (spec.version !== undefined && info.version !== spec.version) {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `${spec.name} needs TM1 v${spec.version}; connection "${info.name}" is v${info.version}.`,
          hint: `Pick a v${spec.version} connection, or use the v${info.version} equivalent.`,
        });
      }
      const tm1Client = await registry.get(connection);
      return handler(rest, tm1Client, extra);
    }) as unknown as ToolCallback<I>;
    server.tool(spec.name, description, input, cb);
  };
}
