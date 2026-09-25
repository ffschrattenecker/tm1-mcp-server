// Per-request TLS dispatcher for TM1 fetches. Replaces the previous
// `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` global side-effect, which
// disabled TLS verification for the entire Node process (including unrelated
// HTTPS calls from MCP transport, telemetry, etc.). With undici's Agent we
// scope `rejectUnauthorized: false` to TM1 fetches only.
//
// The Agent is cached so connection-pooling stays effective across requests.
import { Agent, fetch as undiciFetch } from "undici";
import type { TM1Config } from "../config.js";

//
// headersTimeout/bodyTimeout are switched off on purpose. undici's defaults
// (300 s each) end any request that has not answered after five minutes with
// UND_ERR_HEADERS_TIMEOUT — measured: a 400 s budget died at 300.8 s on both
// fetch paths. A TI process runs as long as it runs and TM1 has no timeout
// for it, so the only limit is our own per-request AbortSignal (timeoutMs),
// which http.ts maps to LOCK_TIMEOUT.
const agents = new Map<boolean, Agent>();

export function getTm1Dispatcher(config: TM1Config): Agent {
  const verify = config.ssl.rejectUnauthorized;
  let agent = agents.get(verify);
  if (!agent) {
    agent = new Agent({
      connect: { rejectUnauthorized: verify },
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    agents.set(verify, agent);
  }
  return agent;
}

// Node's BUILT-IN fetch silently drops Set-Cookie headers when handed a
// dispatcher from the npm undici package (cross-instance Headers handling;
// reproduced on Node 26 + undici 7.25 — auth broke with "no TM1SessionId
// cookie found"). Pair the npm Agent with the npm fetch instead, where the
// instances match. Unit tests stub globalThis.fetch — honor the stub when
// present (identity check against the built-in captured at module load).
const builtinFetch = globalThis.fetch;

export function tm1Fetch(url: string, init: RequestInit): Promise<Response> {
  if (globalThis.fetch !== builtinFetch) {
    return globalThis.fetch(url, init);
  }
  return undiciFetch(url, init as unknown as Parameters<typeof undiciFetch>[1]);
}
