// Adapter helpers to read AbortSignal, _meta, HTTP headers, and progress
// notifications from either v2 ServerContext (ctx.mcpReq.*) or legacy/unit-test
// shapes (extra.signal / extra._meta / extra.sendNotification).
import type { ServerNotification } from "@modelcontextprotocol/server";

export interface ToolCallExtra {
  mcpReq?: {
    signal?: AbortSignal;
    _meta?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
    notify?: (notification: ServerNotification) => Promise<void>;
  };
  http?: {
    req?: {
      headers?: Headers | Record<string, string | string[] | undefined>;
    };
  };
  // Legacy / unit-test fallback fields:
  signal?: AbortSignal;
  _meta?: Record<string, unknown>;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

export function extraSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const e = extra as ToolCallExtra;
  return e.mcpReq?.signal ?? e.signal;
}

export function extraMeta(extra: unknown): Record<string, unknown> | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const e = extra as ToolCallExtra;
  const meta = e.mcpReq?._meta ?? e._meta;
  const envelope = e.mcpReq?.envelope;
  if (meta && envelope) return { ...envelope, ...meta };
  return meta ?? envelope;
}

export function extraHttpHeaders(
  extra: unknown,
): Headers | Record<string, string | string[] | undefined> | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  return (extra as ToolCallExtra).http?.req?.headers;
}

export function extraNotify(
  extra: unknown,
): ((notification: ServerNotification) => Promise<void>) | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const e = extra as ToolCallExtra;
  if (typeof e.mcpReq?.notify === "function") {
    return (n) => e.mcpReq!.notify!(n);
  }
  if (typeof e.sendNotification === "function") {
    return (n) => e.sendNotification!(n);
  }
  return undefined;
}
