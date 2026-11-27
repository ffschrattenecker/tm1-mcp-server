import type pino from "pino";
import {
  type McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { slimJsonSchema, withSlimJsonSchema } from "../lib/slim-json-schema.js";
import {
  extractTraceContext,
  runWithTraceContext,
  traceLogBindings,
} from "../lib/trace-context.js";
import { extraHttpHeaders, extraMeta } from "./context.js";
import { specFor, type ResolvedSpec } from "./define-tool.js";
import { DEFAULT_MAX_RESPONSE_CHARS } from "../config.js";
import { TM1Error, TM1ErrorCode } from "../types.js";
import { isZodSchema, strictVariants } from "./schemas/markdown-capable.js";
import {
  formatTm1ErrorResult,
  normalizeErrorResult,
  type McpToolResult,
} from "./error-format.js";

// Words whose display casing differs from simple capitalization.
const TITLE_CASING: Record<string, string> = {
  mdx: "MDX",
  ti: "TI",
  v12: "v12",
  v11: "v11",
};

// Derive a human-readable title from a snake_case tool name:
// "tm1_get_process" → "Get Process".
export function deriveTitle(toolName: string): string {
  return toolName
    .replace(/^tm1_/, "")
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => TITLE_CASING[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// An output schema is either a raw shape or a full Zod schema
// (passthrough/catchall). Normalize to a parseable schema.
function asZodSchema(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  return isZodSchema(entry) ? entry : z.object(entry);
}

// The SDK wraps a raw input shape in a plain z.object, which drops unknown keys
// without an error. Reject unknown keys instead, and name the ones accepted.
export function strictInputSchema(shape: ZodRawShape): ZodTypeAny {
  const accepted = Object.keys(shape);
  const list = accepted.length > 0 ? accepted.join(", ") : "none";
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === "unrecognized_keys"
        ? `Unknown parameter(s): ${iss.keys.join(", ")}. Accepted: ${list}.`
        : undefined,
  });
}

// A markdown response carries exactly one key. Anything else is the JSON path.
function isMarkdownPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "markdown" &&
    typeof (value as { markdown: unknown }).markdown === "string"
  );
}

// Characters the client receives for a successful result: the text blocks, or
// the serialized structuredContent when "structured" mode emptied content[].
function responseChars(result: McpToolResult): number {
  const text = (result.content ?? []).reduce(
    (n, c) => n + (typeof c.text === "string" ? c.text.length : 0),
    0,
  );
  if (text > 0 || result.structuredContent === undefined) return text;
  return JSON.stringify(result.structuredContent).length;
}

interface PagePayload {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  items: unknown[];
  [k: string]: unknown;
}

function isPagePayload(value: unknown): value is PagePayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.items) &&
    typeof v.offset === "number" &&
    typeof v.total === "number"
  );
}

/**
 * Cut an oversized page down to the longest prefix of its items that fits.
 */
export function trimPageToFit(
  result: McpToolResult,
  maxChars: number,
): McpToolResult | undefined {
  const page = result.structuredContent;
  if (!isPagePayload(page)) return undefined;
  const withText = (result.content ?? []).some((c) => c.type === "text");
  const build = (n: number): McpToolResult => {
    const trimmed: PagePayload = {
      ...page,
      count: n,
      has_more: true, // n < items.length: at least one item was dropped
      next_offset: page.offset + n,
      items: page.items.slice(0, n),
    };
    return {
      ...result,
      content: withText
        ? [{ type: "text" as const, text: JSON.stringify(trimmed) }]
        : [],
      structuredContent: trimmed,
    };
  };
  let lo = 0;
  let hi = page.items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (responseChars(build(mid)) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? build(lo) : undefined;
}

// How to narrow a call, derived from the tool's own input keys.
export function narrowingHint(inputKeys: ReadonlySet<string>): string {
  const ways: string[] = [];
  if (inputKeys.has("outline"))
    ways.push("outline=true to see the sections, then lineRange for a slice");
  else if (inputKeys.has("lineRange")) ways.push("lineRange for a slice");
  if (inputKeys.has("countOnly")) ways.push("countOnly=true to size it first");
  if (inputKeys.has("limit"))
    ways.push("a smaller limit, walking on with offset/next_offset");
  else if (inputKeys.has("topN"))
    ways.push("a smaller topN, walking on with offset");
  if (inputKeys.has("maxBytes") || inputKeys.has("headLines"))
    ways.push("a smaller maxBytes or headLines");
  if (inputKeys.has("summary")) ways.push("summary=true");
  if (inputKeys.has("compact")) ways.push("compact=true");
  const tail =
    ways.length > 0
      ? `Use ${ways.join("; or ")}.`
      : "Narrow the request (filters, fewer objects) and retry.";
  return `${tail} Raise TM1_MAX_RESPONSE_CHARS only if the client can take the full payload.`;
}

export type ToolCallback = (...cbArgs: unknown[]) => unknown;

const SLOW_TOOL_MS = 5000;

/**
 * Shared post-processing for any tool result (used by both synchronous tool
 * calls and MCP Tasks completion): normalizes errors, attaches structuredContent,
 * validates against strict outputSchema, and enforces TM1_MAX_RESPONSE_CHARS.
 */
export function postProcessToolResult(
  toolName: string,
  result: McpToolResult | undefined,
  opts: {
    outputSchema?: ZodRawShape | ZodTypeAny | undefined;
    responseMode: "legacy" | "structured";
    maxResponseChars: number;
    sizeHint: string;
    logger: pino.Logger;
  },
): McpToolResult | undefined {
  if (!result) return result;
  if (result.isError) {
    return normalizeErrorResult(result);
  }
  const schema = opts.outputSchema ? asZodSchema(opts.outputSchema) : undefined;
  if (!schema) {
    return guardResponseSize(
      toolName,
      result,
      opts.maxResponseChars,
      opts.sizeHint,
      opts.logger,
    );
  }

  const withStructured = attachStructuredContent(result, opts.responseMode);
  if (withStructured.structuredContent !== undefined) {
    const variants = strictVariants(opts.outputSchema);
    const effectiveSchema = variants
      ? isMarkdownPayload(withStructured.structuredContent)
        ? variants.markdown
        : variants.json
      : schema;
    const parsed = effectiveSchema.safeParse(withStructured.structuredContent);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = issue
        ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
        : "unknown issue";
      opts.logger.warn(
        { tool: toolName, issues: parsed.error.issues.slice(0, 5) },
        "output schema drift",
      );
      return formatTm1ErrorResult(
        new Error(`output schema drift in ${toolName}: ${detail}`),
      );
    }
  }
  return guardResponseSize(
    toolName,
    withStructured,
    opts.maxResponseChars,
    opts.sizeHint,
    opts.logger,
  );
}

function attachStructuredContent(
  result: McpToolResult,
  responseMode: "legacy" | "structured",
): McpToolResult {
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return result;
  }
  const raw = first.text.trim();
  if (!raw.startsWith("{") && !raw.startsWith("[")) return result;
  try {
    const parsed = JSON.parse(raw) as McpToolResult["structuredContent"];
    return responseMode === "structured"
      ? { ...result, content: [], structuredContent: parsed }
      : { ...result, structuredContent: parsed };
  } catch {
    return result;
  }
}

function guardResponseSize(
  toolName: string,
  result: McpToolResult,
  maxResponseChars: number,
  hint: string,
  logger: pino.Logger,
): McpToolResult {
  const size = responseChars(result);
  if (size <= maxResponseChars) return result;
  const trimmed = trimPageToFit(result, maxResponseChars);
  if (trimmed) {
    logger.info(
      { tool: toolName, size, maxResponseChars },
      "page trimmed to fit the response limit",
    );
    return trimmed;
  }
  logger.warn({ tool: toolName, size, maxResponseChars }, "response too large");
  return formatTm1ErrorResult(
    new TM1Error({
      code: TM1ErrorCode.RESPONSE_TOO_LARGE,
      message: `${toolName} produced ${size} characters, over the ${maxResponseChars}-character response limit. Nothing was returned.`,
      hint,
      details: JSON.stringify({ size, limit: maxResponseChars }),
    }),
  );
}

export interface PreparedToolRegistration {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  taskSupport?: "optional" | "required";
  keywords?: readonly string[];
  strictInput: ZodTypeAny;
  slimInputSchema: StandardSchemaWithJSON<unknown, unknown>;
  outputSchema?: ZodRawShape | ZodTypeAny;
  slimOutputSchema?: StandardSchemaWithJSON<unknown, unknown>;
  outputSchemaJson?: Record<string, unknown>;
  sizeHint: string;
  wrappedCb: ToolCallback;
}

/**
 * Prepare a tool registration with strict input validation, slimmed JSON
 * Schemas, OTel trace propagation, slow-call logging, output-schema guard,
 * response size guard, and uniform error formatting.
 */
export function prepareToolRegistration(
  name: string,
  description: string,
  rawInputShape: ZodRawShape,
  rawCb: ToolCallback,
  opts: {
    logger: pino.Logger;
    mode: "readwrite" | "sandbox" | "readonly";
    responseMode: "legacy" | "structured";
    maxResponseChars: number;
  },
): PreparedToolRegistration | undefined {
  const spec = specFor(name) as ResolvedSpec;
  const annot = spec.annotations;
  if (opts.mode === "readonly" && !annot.readOnlyHint) {
    return undefined;
  }
  if (opts.mode === "sandbox" && !annot.readOnlyHint && !spec.sandboxScoped) {
    return undefined;
  }

  const outputSchema = spec.outputSchema;
  const inputKeys = new Set(Object.keys(rawInputShape));
  const sizeHint = narrowingHint(inputKeys);
  const strictInput = strictInputSchema(rawInputShape);
  const slimInputSchema = withSlimJsonSchema(strictInput);
  const slimOutputSchema = outputSchema
    ? withSlimJsonSchema(asZodSchema(outputSchema))
    : undefined;
  const outputSchemaJson = slimOutputSchema
    ? (slimJsonSchema(
        slimOutputSchema["~standard"].jsonSchema.output({
          target: "draft-2020-12",
        }),
      ) as Record<string, unknown>)
    : undefined;

  const wrappedCb: ToolCallback = async (...cbArgs: unknown[]) => {
    const extra = cbArgs[1];
    const trace = extractTraceContext(
      extraMeta(extra),
      extraHttpHeaders(extra),
    );
    const callLogger = opts.logger.child({
      tool: name,
      ...traceLogBindings(trace),
    });

    return runWithTraceContext(trace, async () => {
      const start = Date.now();
      try {
        const result = (await rawCb(...cbArgs)) as McpToolResult | undefined;
        const durationMs = Date.now() - start;
        if (durationMs >= SLOW_TOOL_MS) {
          callLogger.warn(
            { tool: name, durationMs },
            `slow tool call: ${name} took ${durationMs}ms`,
          );
        }
        return postProcessToolResult(name, result, {
          outputSchema,
          responseMode: opts.responseMode,
          maxResponseChars: opts.maxResponseChars,
          sizeHint,
          logger: callLogger,
        });
      } catch (err) {
        callLogger.error({ err, tool: name }, "Tool handler threw");
        return formatTm1ErrorResult(err);
      }
    });
  };

  return {
    name,
    title: deriveTitle(name),
    description,
    annotations: annot,
    ...(spec.taskSupport !== undefined
      ? { taskSupport: spec.taskSupport }
      : {}),
    ...(spec.keywords !== undefined ? { keywords: spec.keywords } : {}),
    strictInput,
    slimInputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(slimOutputSchema !== undefined ? { slimOutputSchema } : {}),
    ...(outputSchemaJson !== undefined ? { outputSchemaJson } : {}),
    sizeHint,
    wrappedCb,
  };
}

// Wrap McpServer so every server.registerTool(name, config, cb) call:
//   1) injects title and the annotation declared in the tool's defineTool() spec
//   2) wraps input/output schemas with strict input + cached slimJsonSchema
//   3) wraps the callback with OTel trace context, error normalization, output
//      schema validation, and response size guard
//   4) filters write/destructive tools according to `mode`
export function withAnnotations(
  server: McpServer,
  logger: pino.Logger,
  mode: "readwrite" | "sandbox" | "readonly",
  responseMode: "legacy" | "structured" = "legacy",
  maxResponseChars: number = DEFAULT_MAX_RESPONSE_CHARS,
): McpServer {
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver) as unknown;
      }
      return (
        name: string,
        rawConfig: {
          description?: string;
          inputSchema?: ZodRawShape;
        },
        rawCb: ToolCallback,
      ) => {
        const prepared = prepareToolRegistration(
          name,
          rawConfig.description ?? "",
          rawConfig.inputSchema ?? {},
          rawCb,
          { logger, mode, responseMode, maxResponseChars },
        );
        if (!prepared) return undefined;
        const config: Record<string, unknown> = {
          title: prepared.title,
          description: prepared.description,
          inputSchema: prepared.slimInputSchema,
          annotations: prepared.annotations,
        };
        if (prepared.slimOutputSchema) {
          config.outputSchema = prepared.slimOutputSchema;
        }
        return originalRegisterTool(name, config, prepared.wrappedCb);
      };
    },
  });
}
