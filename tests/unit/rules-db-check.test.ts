import { describe, it, expect } from "vitest";
import { checkDbReferences } from "../../src/lib/rules-db-check.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

const CUBES: Record<string, string[]> = {
  Sales: ["Sandboxes", "Region", "Product", "Measure"],
  Rates: ["Currency", "Rate"],
};

// Elements per dimension, lowercased the way TM1 resolves them; 'Region' has
// an alternate hierarchy 'ByCountry'.
const ELEMENTS: Record<string, string[]> = {
  "region/region": ["north", "south", "n"],
  "region/bycountry": ["austria"],
  "product/product": ["base"],
  "measure/measure": ["qty", "amount", "price"],
  "currency/currency": ["eur", "usd"],
  "rate/rate": ["rate"],
};

const lookups = (onExists?: (dim: string, el: string) => void) => ({
  cubes: {
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
  },
  elements: {
    exists: async (dim: string, hier: string, el: string) => {
      onExists?.(dim, el);
      if (el === "Denied") throw new Error("403 forbidden");
      const list = ELEMENTS[`${dim}/${hier}`.toLowerCase()];
      if (!list)
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: `Hierarchy '${hier}' not found`,
        });
      return list.includes(el.toLowerCase().replace(/\s+/g, ""));
    },
  },
});

describe("checkDbReferences", () => {
  it("flags too few and too many elements, Sandboxes not counted", async () => {
    const issues = await checkDbReferences(
      lookups(),
      [
        "SKIPCHECK;",
        "['Amount'] = N: DB('Sales', !Region, !Product) * DB('Rates', 'EUR', 'Rate');",
        "['Price'] = N: DB('Sales', 'Base', !Region, !Product, 'Price');",
      ].join("\n"),
    );
    expect(issues).toMatchObject([
      { lineNumber: 2, cube: "Sales" },
      { lineNumber: 3, cube: "Sales" },
    ]);
    expect(issues[0].message).toMatch(
      /passes 2 element\(s\), the cube takes 3/,
    );
    expect(issues[1].message).toMatch(
      /passes 4 element\(s\), the cube takes 3/,
    );
  });

  it("flags a cube that does not exist", async () => {
    const issues = await checkDbReferences(
      lookups(),
      "['A'] = N: DB('Gone', !Region);\nFEEDERS;\n['B'] => DB('Gone', !Region);",
    );
    expect(issues).toMatchObject([
      { lineNumber: 1, cube: "Gone" },
      { lineNumber: 3, cube: "Gone" },
    ]);
    expect(issues[0].message).toMatch(/names a cube that does not exist/);
  });

  it("flags a literal element that is not in the dimension at its position", async () => {
    const issues = await checkDbReferences(
      lookups(),
      [
        "['A'] = N: DB('Sales', 'West', !Product, 'Qty');",
        "FEEDERS;",
        "['Qty'] => DB('Rates', 'CHF', 'Rate');",
      ].join("\n"),
    );
    expect(issues).toMatchObject([
      { lineNumber: 1, cube: "Sales" },
      { lineNumber: 3, cube: "Rates" },
    ]);
    expect(issues[0].message).toMatch(
      /element 'West', which is not in dimension 'Region'/,
    );
    expect(issues[1].message).toMatch(/element 'CHF'.*'Currency'/);
  });

  it("accepts what TM1 resolves: other case and spacing, aliases, Hierarchy:Element", async () => {
    const issues = await checkDbReferences(
      lookups(),
      [
        "['A'] = N: DB('Sales', 'NORTH', 'Ba se', 'Qty');",
        "['B'] = N: DB('Sales', 'N', !Product, 'Amount');",
        "['C'] = N: DB('Sales', 'ByCountry:Austria', !Product, 'Price');",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
  });

  it("looks each element up once and reports every line that names it", async () => {
    const looked: string[] = [];
    const issues = await checkDbReferences(
      lookups((dim, el) => looked.push(`${dim}/${el}`)),
      [
        "['A'] = N: DB('Sales', 'West', !Product, 'Qty');",
        "['B'] = N: DB('Sales', 'west', !Product, 'Qty');",
      ].join("\n"),
    );
    expect(issues.map((i) => i.lineNumber)).toEqual([1, 2]);
    expect(looked.filter((l) => l === "Region/West")).toHaveLength(1);
    expect(looked.filter((l) => l.startsWith("Measure/"))).toHaveLength(1);
  });

  it("does not look up elements of a call with the wrong count", async () => {
    const looked: string[] = [];
    const issues = await checkDbReferences(
      lookups((dim, el) => looked.push(`${dim}/${el}`)),
      "['A'] = N: DB('Sales', 'West', 'Qty');",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/passes 2 element/);
    expect(looked).toEqual([]);
  });

  it("follows a call over several lines, nested calls and the feeder section", async () => {
    const issues = await checkDbReferences(
      lookups(),
      [
        "['Amount'] = N: DB('Sales',",
        "    ATTRS('Region', !Region, 'Parent'),",
        "    !Product, 'Qty') * DB('Rates', DB('Sales', !Region, !Product), 'Rate');",
        "FEEDERS;",
        "['Qty'] => DB('Sales', !Region, 'Amount');",
      ].join("\n"),
    );
    expect(issues).toMatchObject([
      { lineNumber: 3, cube: "Sales" },
      { lineNumber: 5, cube: "Sales" },
    ]);
  });

  it("ignores comments, strings, computed cube names, computed and empty elements", async () => {
    const issues = await checkDbReferences(
      lookups(),
      [
        "# ['X'] = N: DB('Sales', !Region);",
        "['Note'] = S: 'see DB(''Gone'', x)'; # DB('Gone', 1)",
        "['A'] = N: DB(ATTRS('Region', !Region, 'Cube'), !Region);",
        "['C'] = N: DB('Rates', !Currency, 'Rate');",
        "['D'] = N: DB('Rates', ATTRS('Region', !Region, 'Cur'), '');",
        "['E'] = N: DB('Rates', 'E' | 'UR', 'Rate');",
      ].join("\r\n"),
    );
    expect(issues).toEqual([]);
  });

  it("surfaces a failing lookup instead of skipping the cube or element", async () => {
    await expect(
      checkDbReferences(lookups(), "['A'] = N: DB('Locked', 1);"),
    ).rejects.toThrow(/401/);
    await expect(
      checkDbReferences(lookups(), "['A'] = N: DB('Rates', 'Denied', 'Rate');"),
    ).rejects.toThrow(/403/);
  });
});
