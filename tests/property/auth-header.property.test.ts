/**
 * Feature: tm1-mcp-server, Property 2: Authentifizierungs-Header-Konstruktion
 *
 * For every combination of username and password, the generated Authorization header
 * matches the format `Basic base64(user:password)`.
 *
 * **Validates: Requirements 7.1**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { SessionManager } from "../../src/session-manager.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockLogger } from "../helpers/client-harness.js";

const originalFetch = globalThis.fetch;

describe("Property 2: Authentifizierungs-Header-Konstruktion", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("Authorization header matches Basic base64(user:password) for any credentials", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        async (user, password) => {
          const localFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: "OK",
            headers: new Headers({
              "set-cookie": "TM1SessionId=sess123; Path=/",
            }),
            json: vi.fn().mockResolvedValue({}),
            text: vi.fn().mockResolvedValue(""),
          });
          globalThis.fetch = localFetch as typeof fetch;

          const sm = new SessionManager(
            makeTestConfig({ user, password }),
            mockLogger,
          );
          await sm.authenticate();

          expect(localFetch).toHaveBeenCalledOnce();
          const [, opts] = localFetch.mock.calls[0];
          const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
          expect(opts.headers.Authorization).toBe(expectedAuth);
        },
      ),
      { numRuns: 100 },
    );
  });
});
