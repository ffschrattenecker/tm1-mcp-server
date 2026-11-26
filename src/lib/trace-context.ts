// W3C Trace Context propagation across MCP _meta / HTTP headers -> pino logs -> TM1 REST calls.
import { AsyncLocalStorage } from "node:async_hooks";

export const TRACEPARENT_KEY = "traceparent";
export const TRACESTATE_KEY = "tracestate";
export const BAGGAGE_KEY = "baggage";

export interface TraceContext {
  traceparent: string;
  traceId: string;
  spanId: string;
  traceFlags: string;
  tracestate?: string;
  baggage?: string;
}

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE_ID = "00000000000000000000000000000000";
const ALL_ZERO_SPAN_ID = "0000000000000000";

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Parse a W3C `traceparent` header/meta value, normalizing hex to lowercase.
 * Rejects invalid formats, version `ff`, all-zero traceId, and all-zero spanId.
 */
export function parseTraceparent(
  raw: string,
):
  | Pick<TraceContext, "traceparent" | "traceId" | "spanId" | "traceFlags">
  | undefined {
  const m = TRACEPARENT_RE.exec(raw.trim());
  if (!m) return undefined;
  const version = m[1]!.toLowerCase();
  const traceId = m[2]!.toLowerCase();
  const spanId = m[3]!.toLowerCase();
  const traceFlags = m[4]!.toLowerCase();
  if (version === "ff") return undefined;
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return undefined;
  }
  return {
    traceparent: `${version}-${traceId}-${spanId}-${traceFlags}`,
    traceId,
    spanId,
    traceFlags,
  };
}

function readHeader(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const val = rec[name] ?? rec[name.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return typeof val === "string" ? val : undefined;
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const val = obj?.[key];
  return typeof val === "string" && val.trim() !== "" ? val.trim() : undefined;
}

/**
 * Extract W3C Trace Context from MCP request `_meta` (preferred per MCP spec)
 * with fallback to HTTP request headers when `_meta` does not carry `traceparent`.
 */
export function extractTraceContext(
  meta?: Record<string, unknown>,
  httpHeaders?: Headers | Record<string, string | string[] | undefined>,
): TraceContext | undefined {
  const rawTraceparent =
    stringField(meta, TRACEPARENT_KEY) ??
    readHeader(httpHeaders, TRACEPARENT_KEY);
  if (!rawTraceparent) return undefined;
  const parsed = parseTraceparent(rawTraceparent);
  if (!parsed) return undefined;

  const tracestate =
    stringField(meta, TRACESTATE_KEY) ??
    readHeader(httpHeaders, TRACESTATE_KEY);
  const baggage =
    stringField(meta, BAGGAGE_KEY) ?? readHeader(httpHeaders, BAGGAGE_KEY);

  return {
    ...parsed,
    ...(tracestate ? { tracestate } : {}),
    ...(baggage ? { baggage } : {}),
  };
}

/** Run `fn` with `ctx` active in AsyncLocalStorage (no-op wrapper if undefined). */
export function runWithTraceContext<T>(
  ctx: TraceContext | undefined,
  fn: () => T,
): T {
  if (!ctx) return fn();
  return traceStorage.run(ctx, fn);
}

/** Active trace context in the current async execution flow, if any. */
export function currentTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/** Pino log bindings for the given trace context (empty when absent). */
export function traceLogBindings(
  ctx: TraceContext | undefined = currentTraceContext(),
): Record<string, string> {
  if (!ctx) return {};
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: ctx.traceFlags,
  };
}

/** Outbound W3C trace headers for TM1 REST calls (empty when absent). */
export function traceOutboundHeaders(
  ctx: TraceContext | undefined = currentTraceContext(),
): Record<string, string> {
  if (!ctx) return {};
  return {
    traceparent: ctx.traceparent,
    ...(ctx.tracestate ? { tracestate: ctx.tracestate } : {}),
  };
}
