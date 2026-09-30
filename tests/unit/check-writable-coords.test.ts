import { describe, it, expect } from "vitest";
import { registerCheckWritableCoords } from "../../src/tools/celldata/check-writable-coords.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { captureParsedTool, captureTool } from "../helpers/client-harness.js";

type Types = Record<string, { name: string; type: string } | null>;

function setup(opts: { dims?: string[] | "missing"; types: Types }) {
  const lookups: Array<[string, string, string]> = [];
  const client = {
    cubes: {
      getDimensionNames: async () => {
        if (opts.dims === "missing") {
          throw new TM1Error({ code: TM1ErrorCode.NOT_FOUND, message: "404" });
        }
        return opts.dims ?? ["Version", "Measure"];
      },
      getRules: async () => ({ rulesText: "" }),
    },
    elements: {
      getType: async (d: string, h: string, e: string) => {
        lookups.push([d, h, e]);
        return opts.types[e] ?? null;
      },
    },
  } as unknown as TM1Client;
  const h = captureParsedTool(registerCheckWritableCoords, client);
  const call = async (args: Record<string, unknown>) => {
    const res = (await h(args)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  };
  return { call, lookups };
}

describe("tm1_check_writable_coords", () => {
  it("looks up one element per dimension by key and reports the stored name", async () => {
    const { call, lookups } = setup({
      types: {
        actual: { name: "Actual", type: "Numeric" },
        amount: { name: "Amount", type: "Numeric" },
      },
    });
    const res = await call({ cubeName: "C", coords: ["actual", "amount"] });
    expect(lookups).toEqual([
      ["Version", "Version", "actual"],
      ["Measure", "Measure", "amount"],
    ]);
    expect(res).toMatchObject({
      writable: true,
      coords: [
        { dimension: "Version", element: "Actual", exists: true },
        { dimension: "Measure", element: "Amount", exists: true },
      ],
    });
  });

  it("flags a missing element and a consolidation", async () => {
    const { call } = setup({
      types: { Total: { name: "Total", type: "Consolidated" } },
    });
    const res = await call({ cubeName: "C", coords: ["Total", "Nope"] });
    expect(res).toMatchObject({
      writable: false,
      coords: [
        { element: "Total", exists: true, isNLevel: false },
        { element: "Nope", exists: false, type: "(missing)" },
      ],
    });
  });

  it("names the cube when it does not exist", async () => {
    const { call } = setup({ dims: "missing", types: {} });
    await expect(call({ cubeName: "Ghost", coords: ["a"] })).rejects.toThrow(
      "Cube 'Ghost' not found",
    );
  });
});

// tm1_check_writable_coords used to load every hierarchy of the cube in full
// (Parents + Edges on every element) to find one name per dimension, and it
// only ever looked in the default hierarchy — so a `[Dim].[Hier].[Elem]`
// coordinate that tm1_write_cells accepts came back as "(missing)".

// Region has DE only in the alternate hierarchy AltHier.
const ELEMENTS: Record<string, { name: string; type: string }> = {
  "Region/AltHier/de": { name: "DE", type: "Numeric" },
  "Region/Region/europe": { name: "Europe", type: "Consolidated" },
  "Month/Month/jan": { name: "Jan", type: "Numeric" },
};

function run(coords: string[], dimensions?: string[]) {
  const lookups: string[] = [];
  const tm1 = {
    cubes: {
      getDimensionNames: async () => ["Region", "Month"],
      getRules: async () => ({ rulesText: "" }),
    },
    elements: {
      getType: async (d: string, h: string, e: string) => {
        lookups.push(`${d}/${h}/${e}`);
        return ELEMENTS[`${d}/${h}/${e.toLowerCase()}`] ?? null;
      },
    },
  };
  const { cb } = captureTool(
    registerCheckWritableCoords,
    tm1 as unknown as TM1Client,
  );
  return cb({ cubeName: "Sales", coords, dimensions }, {}).then((r) => ({
    out: JSON.parse(r.content[0].text) as {
      writable: boolean;
      coords: Array<{ element: string; exists: boolean; type: string }>;
    },
    lookups,
  }));
}

describe("tm1_check_writable_coords — hierarchies", () => {
  it("resolves a qualified coordinate in the hierarchy it names", async () => {
    const { out, lookups } = await run(["[Region].[AltHier].[DE]", "Jan"]);
    expect(lookups[0]).toBe("Region/AltHier/DE");
    expect(out.coords[0]).toMatchObject({ exists: true, type: "Numeric" });
    expect(out.writable).toBe(true);
  });

  it("does not find an unqualified alt-hierarchy element in the default hierarchy", async () => {
    const { out } = await run(["DE", "Jan"]);
    expect(out.coords[0]).toMatchObject({ exists: false, type: "(missing)" });
  });

  it("reorders coords given in the write's dimension order", async () => {
    const { out } = await run(
      ["Jan", "[Region].[AltHier].[DE]"],
      ["Month", "Region"],
    );
    expect(out.writable).toBe(true);
    expect(out.coords.map((c) => c.element)).toEqual([
      "[Region].[AltHier].[DE]",
      "Jan",
    ]);
  });

  it("refuses a dimension list that misses a cube dimension", async () => {
    await expect(run(["Jan"], ["Month"])).rejects.toThrow(/missing: Region/);
  });
});
