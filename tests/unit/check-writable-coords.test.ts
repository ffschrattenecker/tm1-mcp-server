// tm1_check_writable_coords used to load every hierarchy of the cube in full
// (Parents + Edges on every element) to find one name per dimension, and it
// only ever looked in the default hierarchy — so a `[Dim].[Hier].[Elem]`
// coordinate that tm1_write_cells accepts came back as "(missing)".
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerCheckWritableCoords } from "../../src/tools/celldata/check-writable-coords.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

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
      list: async () => [{ name: "Sales", dimensions: ["Region", "Month"] }],
      getRules: async () => ({ rulesText: "" }),
    },
    elements: {
      getType: async (d: string, h: string, e: string) => {
        lookups.push(`${d}/${h}/${e}`);
        return ELEMENTS[`${d}/${h}/${e.toLowerCase()}`] ?? null;
      },
    },
    hierarchies: {
      get: () => {
        throw new Error("must not load a whole hierarchy");
      },
    },
  };
  let cb: ToolCb | undefined;
  registerCheckWritableCoords(
    {
      tool: (_n: string, _d: string, _s: unknown, h: ToolCb) => {
        cb = h;
      },
    } as unknown as McpServer,
    tm1 as unknown as TM1Client,
  );
  return cb!({ cubeName: "Sales", coords, dimensions }, {}).then((r) => ({
    out: JSON.parse(r.content[0].text) as {
      writable: boolean;
      coords: Array<{ element: string; exists: boolean; type: string }>;
    },
    lookups,
  }));
}

describe("tm1_check_writable_coords", () => {
  it("looks up each coordinate by key and reports the stored spelling", async () => {
    const { out, lookups } = await run(["europe", "jan"]);
    expect(lookups).toEqual(["Region/Region/europe", "Month/Month/jan"]);
    expect(out.coords.map((c) => c.element)).toEqual(["Europe", "Jan"]);
    expect(out.writable).toBe(false); // Europe is a consolidation
  });

  it("resolves a qualified coordinate in the hierarchy it names", async () => {
    const { out, lookups } = await run(["[Region].[AltHier].[DE]", "Jan"]);
    expect(lookups[0]).toBe("Region/AltHier/DE");
    expect(out.coords[0]).toMatchObject({ exists: true, type: "Numeric" });
    expect(out.writable).toBe(true);
  });

  it("reports a missing element as missing", async () => {
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
