import { describe, it, expect } from "vitest";
import { dimensionCountMismatch } from "../../src/lib/coordinate-error.js";
import { TM1ErrorCode } from "../../src/types.js";

describe("dimensionCountMismatch", () => {
  it("returns VALIDATION_ERROR with a per-position mapping of the cube's dimensions", () => {
    const err = dimensionCountMismatch(
      "Sales",
      ["Sandboxes", "Version", "Year", "Account", "Measure"],
      ["Actual", "2026", "Revenue", "Value"],
    );
    expect(err.code).toBe(TM1ErrorCode.VALIDATION_ERROR);
    expect(JSON.parse(err.details!)).toEqual([
      { dimension: "Sandboxes", element: "Actual" },
      { dimension: "Version", element: "2026" },
      { dimension: "Year", element: "Revenue" },
      { dimension: "Account", element: "Value" },
      { dimension: "Measure", element: null },
    ]);
  });
});

describe("tm1_write_cells short tuple", () => {
  it("fails before writing, naming the uncovered dimension", async () => {
    const { registerWriteCells } =
      await import("../../src/tools/celldata/write-cells.js");
    const { z } = await import("zod");
    let h: ((a: unknown) => Promise<unknown>) | undefined;
    let shape: Record<string, never> = {};
    const writes: unknown[] = [];
    registerWriteCells(
      {
        tool: (_n: string, _d: string, s: never, cb: typeof h) => {
          shape = s;
          h = cb;
        },
      } as never,
      {
        cells: { writeCells: async (...a: unknown[]) => void writes.push(a) },
      } as never,
    );
    const args = z.object(shape).parse({
      cubeName: "Sales",
      dimensions: ["Version", "Measure"],
      cells: [{ elements: ["Actual"], value: 1 }],
      confirm: "Sales",
    });
    await expect(h!(args)).rejects.toThrow("(by position): Measure");
    expect(writes).toEqual([]);
  });
});
