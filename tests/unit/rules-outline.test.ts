import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import {
  OUTLINE_MAX_ENTRIES,
  outlineRules,
  sliceLines,
} from "../../src/lib/rules-outline.js";
import { registerGetCubeRules } from "../../src/tools/model-building/get-cube-rules.js";
import type { TM1Client } from "../../src/tm1-client.js";

// Shape of a real rule file: a header comment block, SKIPCHECK, numbered
// comment blocks introducing each rule group, FEEDERS, a feeder comment.
const RULES = [
  "# Sales rules. Source: fragments/sales.rules.txt", // 1
  "# second header line", // 2
  "SKIPCHECK;", // 3
  "", // 4
  "#####################", // 5
  "# 1) Variance columns first", // 6
  "#    continued explanation", // 7
  "['Version':'Var'] = ['Version':'Fcst'] - ['Version':'Plan'];", // 8
  "", // 9
  "# 2) Price per unit", // 10
  "['Measure':'Price'] = ['Measure':'Rev'] \\ ['Measure':'Qty'];", // 11
  "", // 12
  "FEEDERS;", // 13
  "# one feeder per target", // 14
  "['Version':'Plan'] => ['Version':'Var'];", // 15
].join("\r\n");

describe("outlineRules", () => {
  it("lists directives and the first worded line of every comment block", () => {
    const { outline, truncated } = outlineRules(RULES);
    expect(truncated).toBe(false);
    expect(outline).toEqual([
      { line: 1, text: "# Sales rules. Source: fragments/sales.rules.txt" },
      { line: 3, text: "SKIPCHECK;" },
      { line: 6, text: "# 1) Variance columns first" },
      { line: 10, text: "# 2) Price per unit" },
      { line: 13, text: "FEEDERS;" },
      { line: 14, text: "# one feeder per target" },
    ]);
  });

  it("caps the outline and says so", () => {
    const many = Array.from({ length: 500 }, (_, i) => `# c${i}\nx${i};`).join(
      "\n",
    );
    const { outline, truncated } = outlineRules(many);
    expect(outline).toHaveLength(OUTLINE_MAX_ENTRIES);
    expect(truncated).toBe(true);
  });
});

describe("sliceLines", () => {
  it("returns the inclusive 1-based range verbatim, without number prefixes", () => {
    expect(sliceLines(RULES, 10, 11)).toEqual({
      text: "# 2) Price per unit\n['Measure':'Price'] = ['Measure':'Rev'] \\ ['Measure':'Qty'];",
      from: 10,
      to: 11,
    });
  });

  it("clamps a range past the end", () => {
    expect(sliceLines(RULES, 14, 999)).toMatchObject({ from: 14, to: 15 });
  });
});

describe("tm1_get_cube_rules modes", () => {
  function call(args: Record<string, unknown>) {
    let h: ((a: unknown) => Promise<{ content: { text: string }[] }>) | null =
      null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    registerGetCubeRules(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      {
        cubes: {
          getRules: async () => ({
            cubeName: "Sales",
            rulesText: RULES,
            skipCheck: true,
          }),
        },
      } as unknown as TM1Client,
    );
    return h!(parser!.parse(args)).then(
      (r) => JSON.parse(r.content[0].text) as Record<string, unknown>,
    );
  }

  it("outline drops rulesText and reports lineCount", async () => {
    const out = await call({ cubeName: "Sales", outline: true });
    expect(out.rulesText).toBeUndefined();
    expect(out.lineCount).toBe(15);
    expect((out.outline as unknown[]).length).toBe(6);
  });

  it("lineRange returns the slice and the range actually served", async () => {
    const out = await call({ cubeName: "Sales", lineRange: [13, 20] });
    expect(out.rulesText).toBe(
      "FEEDERS;\n# one feeder per target\n['Version':'Plan'] => ['Version':'Var'];",
    );
    expect(out.lineRange).toEqual([13, 15]);
    expect(out.lineCount).toBe(15);
  });

  it("full text stays the default", async () => {
    const out = await call({ cubeName: "Sales" });
    expect(out.rulesText).toBe(RULES);
    expect(out.outline).toBeUndefined();
  });

  it("rejects outline together with lineRange, and an inverted range", async () => {
    await expect(
      call({ cubeName: "Sales", outline: true, lineRange: [1, 2] }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      call({ cubeName: "Sales", lineRange: [5, 2] }),
    ).rejects.toThrow(/inverted/);
  });
});
