/**
 * Feature: tm1-mcp-server, Property 6: Paginierungs-Invariante
 *
 * **Validates: Requirements 3.3**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { FnSpy } from "../helpers/spy-types.js";
import * as fc from "fast-check";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { stubbedClient } from "../helpers/client-harness.js";
function mockResp(body: unknown): Response {
  const t = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(t),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}
const originalFetch = globalThis.fetch;
function makeClient(f: FnSpy) {
  globalThis.fetch = f as typeof fetch;
  const c = makeTestConfig({ requestTimeoutMs: 5000 });
  return stubbedClient(c, "s");
}

describe("Property 6: Paginierungs-Invariante", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("result contains at most `top` cells and correct totalCellCount", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (top, skip, a0, a1) => {
          const total = a0 * a1;
          const effSkip = Math.min(skip, total);
          const retCount = Math.min(top, Math.max(0, total - effSkip));
          const cells = Array.from({ length: retCount }, (_, i) => ({
            Value: i,
            FormattedValue: String(i),
          }));
          const ax0 = Array.from({ length: a0 }, (_, i) => ({
            Members: [{ Name: `M${i}`, Hierarchy: { Name: "D0" } }],
          }));
          const ax1 = Array.from({ length: a1 }, (_, i) => ({
            Members: [{ Name: `N${i}`, Hierarchy: { Name: "D1" } }],
          }));

          const f = vi.fn().mockResolvedValue(
            mockResp({
              ID: "cs",
              Cells: cells,
              Axes: [{ Tuples: ax0 }, { Tuples: ax1 }],
            }),
          );
          const client = makeClient(f);
          const result = await client.cells.executeMdx("SELECT ...", top, skip);
          expect(result.cells.length).toBeLessThanOrEqual(top);
          expect(result.cells.length).toBe(retCount);
          expect(result.totalCellCount).toBe(total);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("result is empty when skip >= total cell count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (a0, a1) => {
          const total = a0 * a1;
          const ax0 = Array.from({ length: a0 }, (_, i) => ({
            Members: [{ Name: `M${i}`, Hierarchy: { Name: "D0" } }],
          }));
          const ax1 = Array.from({ length: a1 }, (_, i) => ({
            Members: [{ Name: `N${i}`, Hierarchy: { Name: "D1" } }],
          }));

          const f = vi.fn().mockResolvedValue(
            mockResp({
              ID: "cs",
              Cells: [],
              Axes: [{ Tuples: ax0 }, { Tuples: ax1 }],
            }),
          );
          const client = makeClient(f);
          const result = await client.cells.executeMdx("SELECT ...", 10, total);
          expect(result.cells).toHaveLength(0);
          expect(result.totalCellCount).toBe(total);
        },
      ),
      { numRuns: 100 },
    );
  });
});
