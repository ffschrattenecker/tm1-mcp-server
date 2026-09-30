import { describe, it, expect } from "vitest";
import { registerCheckWritableCoords } from "../../src/tools/celldata/check-writable-coords.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { captureParsedTool } from "../helpers/client-harness.js";

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
