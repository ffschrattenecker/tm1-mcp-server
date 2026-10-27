import { describe, it, expect } from "vitest";
import { registerCheckAllCubeRules } from "../../src/tools/model-building/check-all-cube-rules.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { captureParsedTool } from "../helpers/client-harness.js";

// Stored rules: Sales is broken by a deleted element (CheckRules) and a DB()
// into a deleted cube; Plan DB()s into Sales twice; Empty has no rules.
const STORED = [
  {
    cubeName: "Sales",
    rulesText: "['Qty'] = N: ['Gone'];\n['Amt'] = N: DB('Old', !Region);",
    skipCheck: false,
    dimensions: ["Region", "Measure"],
  },
  {
    cubeName: "Plan",
    rulesText:
      "['Qty'] = N: DB('Sales', !Region, 'Qty');\n['Amt'] = N: DB('Sales', !Region, 'Qty');",
    skipCheck: false,
    dimensions: ["Region", "Measure"],
  },
  { cubeName: "Empty", rulesText: "  \n", skipCheck: false, dimensions: [] },
];

function setup(opts: { denyCheck?: boolean } = {}) {
  const calls = { checkRule: [] as string[], dims: 0, exists: 0 };
  const client = {
    cubes: {
      getAllRules: async (o: { withDimensions?: boolean }) => {
        expect(o.withDimensions).toBe(true);
        return STORED;
      },
      checkRule: async (cube: string, text: string) => {
        calls.checkRule.push(cube);
        if (opts.denyCheck) throw new Error("403 forbidden");
        return text.includes("'Gone'")
          ? [{ lineNumber: 1, message: 'Element not found "Gone"' }]
          : [];
      },
      getDimensionNames: async () => {
        calls.dims++;
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: "not found",
        });
      },
    },
    elements: {
      exists: async () => {
        calls.exists++;
        return true;
      },
    },
  } as unknown as TM1Client;
  const run = captureParsedTool<{ content: Array<{ text: string }> }>(
    registerCheckAllCubeRules,
    client,
  );
  return { calls, run };
}

describe("tm1_check_all_cube_rules", () => {
  it("returns only cubes with errors, CheckRules and DB() findings together", async () => {
    const { calls, run } = setup();
    const res = JSON.parse((await run({})).content[0].text);
    expect(res).toMatchObject({ cubesChecked: 2, cubesWithErrors: 1 });
    expect(res.cubes).toHaveLength(1);
    expect(res.cubes[0]).toMatchObject({ cube: "Sales", errorCount: 2 });
    expect(res.cubes[0].errors[0].message).toMatch(/Element not found/);
    expect(res.cubes[0].errors[1]).toMatchObject({ lineNumber: 2 });
    expect(res.cubes[0].errors[1].message).toMatch(
      /DB\('Old', \.\.\.\) names a cube that does not exist/,
    );
    // Empty rules are not sent to CheckRules.
    expect(calls.checkRule.sort()).toEqual(["Plan", "Sales"]);
  });

  it("reuses the dimensions it read with the rules and looks each element up once", async () => {
    const { calls, run } = setup();
    await run({});
    // Only the unknown cube 'Old' needs its own request.
    expect(calls.dims).toBe(1);
    // Plan names Sales/Measure 'Qty' twice: one lookup.
    expect(calls.exists).toBe(1);
  });

  it("surfaces a check that could not run instead of reporting a clean cube", async () => {
    const { run } = setup({ denyCheck: true });
    await expect(run({})).rejects.toThrow(/403/);
  });
});
