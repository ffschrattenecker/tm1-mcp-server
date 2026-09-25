// Pins the write-address rules measured live on 11.8.03500: a dimension left
// out of a cellset write lands on its default member without an error, so
// every dimension must be named — except Sandboxes, which is bound to Base
// explicitly instead of being left to TM1's default member.
import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { resolveCellAddress } from "../../src/lib/cell-address.js";
import { registerWriteCells } from "../../src/tools/celldata/write-cells.js";
import type { TM1Client } from "../../src/tm1-client.js";

const PLAIN = ["Version", "Row", "Measure"];
const SANDBOXED = ["Sandboxes", "Row", "Measure"];

describe("resolveCellAddress", () => {
  it("maps a caller's dimension order onto cube order", () => {
    const a = resolveCellAddress("C", PLAIN, ["Measure", "Version", "Row"]);
    expect(a.dimensions).toEqual(PLAIN);
    expect(a.toCubeOrder(["Amount", "Actual", "R1"])).toEqual([
      "Actual",
      "R1",
      "Amount",
    ]);
    expect(a.sandboxDefaulted).toBeUndefined();
  });

  it("matches dimension names case-insensitively", () => {
    const a = resolveCellAddress("C", PLAIN, ["version", "ROW", "measure"]);
    expect(a.toCubeOrder(["A", "R", "M"])).toEqual(["A", "R", "M"]);
  });

  it("refuses a missing regular dimension and names it", () => {
    expect(() => resolveCellAddress("C", PLAIN, ["Version", "Row"])).toThrow(
      /missing: Measure/,
    );
  });

  it("refuses unknown and duplicated dimensions", () => {
    expect(() =>
      resolveCellAddress("C", PLAIN, ["Version", "Row", "Measure", "Year"]),
    ).toThrow(/not in the cube: Year/);
    expect(() =>
      resolveCellAddress("C", PLAIN, ["Version", "Row", "row", "Measure"]),
    ).toThrow(/listed twice: row/);
  });

  it("binds a left-out Sandboxes to Base, explicitly", () => {
    const a = resolveCellAddress("C", SANDBOXED, ["Measure", "Row"]);
    expect(a.sandboxDefaulted).toBe("Base");
    expect(a.toCubeOrder(["Amount", "R1"])).toEqual(["Base", "R1", "Amount"]);
  });

  it("keeps an explicit sandbox member", () => {
    const a = resolveCellAddress("C", SANDBOXED, [
      "Sandboxes",
      "Row",
      "Measure",
    ]);
    expect(a.sandboxDefaulted).toBeUndefined();
    expect(a.toCubeOrder(["SB1", "R1", "Amount"])).toEqual([
      "SB1",
      "R1",
      "Amount",
    ]);
  });

  it("still refuses a regular dimension missing alongside Sandboxes", () => {
    expect(() => resolveCellAddress("C", SANDBOXED, ["Row"])).toThrow(
      /missing: Measure\./,
    );
  });
});

describe("tm1_write_cells address resolution", () => {
  function setup(cubeDims: string[]) {
    const writes: Array<{ dims: string[]; cells: unknown }> = [];
    const client = {
      cubes: { getDimensionNames: async () => cubeDims },
      cells: {
        writeCells: async (_c: string, dims: string[], cells: unknown) => {
          writes.push({ dims, cells });
        },
      },
    } as unknown as TM1Client;
    let h: ((a: unknown) => Promise<unknown>) | null = null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    registerWriteCells(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      client,
    );
    const call = (args: Record<string, unknown>) =>
      h!(parser!.parse(args)) as Promise<{
        structuredContent: Record<string, unknown>;
      }>;
    return { call, writes };
  }

  it("writes in cube order with Base injected, and says so", async () => {
    const { call, writes } = setup(SANDBOXED);
    const res = await call({
      cubeName: "C",
      confirm: "C",
      dimensions: ["Measure", "Row"],
      cells: [{ elements: ["Amount", "R1"], value: 5 }],
    });
    expect(writes).toEqual([
      {
        dims: SANDBOXED,
        cells: [{ elements: ["Base", "R1", "Amount"], value: 5 }],
      },
    ]);
    expect(res.structuredContent).toMatchObject({
      success: true,
      sandboxDefaulted: "Base",
    });
  });

  it("writes nothing when a regular dimension is left out", async () => {
    const { call, writes } = setup(SANDBOXED);
    await expect(
      call({
        cubeName: "C",
        confirm: "C",
        dimensions: ["Sandboxes", "Row"],
        cells: [{ elements: ["Base", "R2"], value: 5 }],
      }),
    ).rejects.toThrow(/missing: Measure/);
    expect(writes).toEqual([]);
  });
});
