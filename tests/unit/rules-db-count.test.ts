import { describe, it, expect } from "vitest";
import { checkDbElementCounts } from "../../src/lib/rules-db-count.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

const CUBES: Record<string, string[]> = {
  Sales: ["Sandboxes", "Region", "Product", "Measure"],
  Rates: ["Currency", "Rate"],
};

const cubes = {
  getDimensionNames: async (c: string) => {
    if (c === "Locked") throw new Error("401 unauthorized");
    const dims = CUBES[c];
    if (!dims)
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `Cube '${c}' not found`,
      });
    return dims;
  },
};

describe("checkDbElementCounts", () => {
  it("flags too few and too many elements, Sandboxes not counted", async () => {
    const issues = await checkDbElementCounts(
      cubes,
      [
        "SKIPCHECK;",
        "['Amount'] = N: DB('Sales', !Region, !Product) * DB('Rates', 'EUR', 'Rate');",
        "['Price'] = N: DB('Sales', 'Base', !Region, !Product, 'Price');",
      ].join("\n"),
    );
    expect(issues).toMatchObject([
      { lineNumber: 2, cube: "Sales", expected: 3, got: 2 },
      { lineNumber: 3, cube: "Sales", expected: 3, got: 4 },
    ]);
    expect(issues[0].message).toMatch(
      /passes 2 element\(s\), the cube takes 3/,
    );
  });

  it("follows a call over several lines, nested calls and the feeder section", async () => {
    const issues = await checkDbElementCounts(
      cubes,
      [
        "['Amount'] = N: DB('Sales',",
        "    ATTRS('Region', !Region, 'Parent'),",
        "    !Product, 'Qty') * DB('Rates', DB('Sales', !Region, !Product), 'Rate');",
        "FEEDERS;",
        "['Qty'] => DB('Sales', !Region, 'Amount');",
      ].join("\n"),
    );
    expect(issues).toMatchObject([
      { lineNumber: 3, cube: "Sales", got: 2 },
      { lineNumber: 5, cube: "Sales", got: 2 },
    ]);
  });

  it("ignores comments, strings, computed and unknown cube names", async () => {
    const issues = await checkDbElementCounts(
      cubes,
      [
        "# ['X'] = N: DB('Sales', !Region);",
        "['Note'] = S: 'see DB(''Sales'', x)'; # DB('Sales', 1)",
        "['A'] = N: DB(ATTRS('Region', !Region, 'Cube'), !Region);",
        "['B'] = N: DB('Gone', !Region);",
        "['C'] = N: DB('Rates', !Currency, 'Rate');",
      ].join("\r\n"),
    );
    expect(issues).toEqual([]);
  });

  it("surfaces a failing lookup instead of skipping the cube", async () => {
    await expect(
      checkDbElementCounts(cubes, "['A'] = N: DB('Locked', 1);"),
    ).rejects.toThrow(/401/);
  });
});
