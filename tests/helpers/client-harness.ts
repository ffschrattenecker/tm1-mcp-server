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
