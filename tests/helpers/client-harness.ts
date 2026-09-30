// Shared scaffolding for unit tests that drive a TM1Client (or one of its
// layers) against a stubbed fetch.
import { vi } from "vitest";
import type pino from "pino";
import type { TM1Config } from "../../src/config.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";

/**
 * A silent pino stand-in. Module state is per test file (vitest isolates
 * modules), so a file asserting on `mockLogger.warn` sees only its own calls.
 */
export const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

/** A fetch `Response` stub whose body is `body` as JSON. */
export function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/**
 * A SessionManager that never reaches the network: `ensureSession` resolves
 * to `cookie`, the 401 re-login (`authenticate`) to `reauth`, and keep-alive
 * is a no-op.
 */
export function stubSession(
  config: TM1Config,
  cookie = "session123",
  reauth = cookie,
): SessionManager {
  const sm = new SessionManager(config, mockLogger);
  vi.spyOn(sm, "ensureSession").mockResolvedValue(cookie);
  vi.spyOn(sm, "authenticate").mockResolvedValue(reauth);
  vi.spyOn(sm, "startKeepAlive").mockImplementation(() => {});
  vi.spyOn(sm, "stopKeepAlive").mockImplementation(() => {});
  return sm;
}

/** A TM1Client over {@link stubSession}, talking to whatever fetch is stubbed. */
export function stubbedClient(config: TM1Config, cookie?: string): TM1Client {
  return new TM1Client(config, stubSession(config, cookie), mockLogger);
}
