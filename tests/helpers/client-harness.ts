// Shared scaffolding for unit tests that drive a TM1Client (or one of its
// layers) against a stubbed fetch.
import { vi } from "vitest";
import type pino from "pino";

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
