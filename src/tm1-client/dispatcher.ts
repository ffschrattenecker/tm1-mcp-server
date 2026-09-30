// Per-request TLS dispatcher for TM1 fetches. Replaces the previous
// `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` global side-effect, which
// disabled TLS verification for the entire Node process (including unrelated
// HTTPS calls from MCP transport, telemetry, etc.). With undici's Agent we
// scope `rejectUnauthorized: false` to TM1 fetches only.
//
// The Agent is cached so connection-pooling stays effective across requests.
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  Agent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
  type buildConnector,
} from "undici";

type connector = buildConnector.connector;
import type { TM1Config } from "../config.js";

//
// headersTimeout/bodyTimeout are switched off on purpose. undici's defaults
// (300 s each) end any request that has not answered after five minutes with
// UND_ERR_HEADERS_TIMEOUT — measured: a 400 s budget died at 300.8 s on both
// fetch paths. A TI process runs as long as it runs and TM1 has no timeout
// for it, so the only limit is our own per-request AbortSignal (timeoutMs),
// which http.ts maps to LOCK_TIMEOUT.
const agents = new Map<string, Agent>();

// A proxied connection cannot use undici's Socks5ProxyAgent as the dispatcher:
// the Pool it builds per origin ignores headersTimeout/bodyTimeout, so a long TI
// run would die at the 300 s default. Instead a plain Agent (timeouts off) gets a
// custom `connect` that opens the SOCKS5 tunnel through a Socks5ProxyAgent and, for
// https targets, layers TLS on top. socks5h:// is accepted as an alias: undici
// always hands the proxy the hostname and lets it resolve.
function proxiedConnect(proxy: string, verify: boolean) {
  const url = new URL(proxy);
  if (url.protocol === "socks5h:") url.protocol = "socks5:";
  // createSocks5Connection is a public method missing from undici's typings.
  const socks = new Socks5ProxyAgent(url) as unknown as {
    createSocks5Connection(host: string, port: number): Promise<Socket>;
  };
  return (
    opts: { hostname: string; port: string; protocol: string },
    callback: (err: Error | null, socket?: Socket) => void,
  ) => {
    const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
    socks.createSocks5Connection(opts.hostname, port).then((socket) => {
      if (opts.protocol !== "https:") return callback(null, socket);
      const tls = tlsConnect({
        socket,
        servername: opts.hostname,
        rejectUnauthorized: verify,
      });
      tls.once("secureConnect", () => callback(null, tls));
      tls.once("error", (err) => callback(err));
    }, callback);
  };
}

export function getTm1Dispatcher(config: TM1Config): Agent {
  const verify = config.ssl.rejectUnauthorized;
  const key = `${verify}|${config.proxy ?? ""}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: config.proxy
        ? (proxiedConnect(config.proxy, verify) as connector)
        : { rejectUnauthorized: verify },
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    agents.set(key, agent);
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
