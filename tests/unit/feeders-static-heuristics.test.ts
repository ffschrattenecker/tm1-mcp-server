import { describe, it, expect, vi } from "vitest";
import {
  detectWildcardBracket,
  detectBroaderThanRule,
  detectBroaderThanMatchedRule,
  findMatchingRule,
  detectOrphanFeeder,
  collectElementBag,
  detectFeederToConsolidated,
  detectDbFeederWithoutSkipcheck,
} from "../../src/lib/feeders/static-heuristics.js";
import { extractBracketLists } from "../../src/lib/feeders/brackets.js";
import { ElementTypeCache } from "../../src/lib/feeders/element-type-cache.js";

function lhs(text: string) {
  const r = extractBracketLists(text)[0];
  if (!r) throw new Error(`parse failed: ${text}`);
  return r;
}

describe("detectWildcardBracket — S4", () => {
  it("flags empty bracket as wildcard", () => {
    expect(detectWildcardBracket(lhs("[]"))).toBe(true);
  });

  it("does not flag bracket with concrete elements", () => {
    expect(detectWildcardBracket(lhs("['A','B']"))).toBe(false);
  });

  it("does not flag qualified bracket with elements", () => {
    expect(detectWildcardBracket(lhs("['Year':'2026']"))).toBe(false);
  });

  it("does not flag set-form bracket with elements", () => {
    expect(detectWildcardBracket(lhs("['Year':{'2025','2026'}]"))).toBe(false);
  });
});

describe("detectBroaderThanRule — S1 (ratio-based)", () => {
  it("flags feeder pinning under half of cube dims (default ratio 0.5)", () => {
    const feeder = lhs("['A','B']");
    expect(detectBroaderThanRule(feeder, 7)).toBe(true); // 2/7 ≈ 0.286 < 0.5
  });

  it("does not flag feeder pinning all cube dims", () => {
    const feeder = lhs("['A','B','C','D','E']");
    expect(detectBroaderThanRule(feeder, 5)).toBe(false);
  });

  it("does not flag wide-cube positional feeder hitting half (13-dim live test)", () => {
    const feeder = lhs("['A','B','C','D','E','F','G']"); // 7 pinned
    expect(detectBroaderThanRule(feeder, 13)).toBe(false); // 7/13 ≈ 0.538 ≥ 0.5
  });

  it("flags wide-cube positional feeder just under half", () => {
    const feeder = lhs("['A','B','C','D','E','F']"); // 6 pinned
    expect(detectBroaderThanRule(feeder, 13)).toBe(true); // 6/13 ≈ 0.462 < 0.5
  });

  it("respects custom ratio", () => {
    const feeder = lhs("['A','B','C']");
    // 3/5 = 0.6
    expect(detectBroaderThanRule(feeder, 5, 0.5)).toBe(false);
    expect(detectBroaderThanRule(feeder, 5, 0.7)).toBe(true);
  });

  it("returns false on empty bracket (S4 territory)", () => {
    const feeder = lhs("[]");
    expect(detectBroaderThanRule(feeder, 5)).toBe(false);
  });

  it("returns false when cubeTotalDims is zero or negative (resolver failure)", () => {
    const feeder = lhs("['A','B']");
    expect(detectBroaderThanRule(feeder, 0)).toBe(false);
    expect(detectBroaderThanRule(feeder, -1)).toBe(false);
  });

  it("does not flag feeder pinning MORE entries than cube has dims (malformed/safer to ignore)", () => {
    const feeder = lhs("['A','B','C','D','E','F']");
    expect(detectBroaderThanRule(feeder, 4)).toBe(false);
  });
});

describe("findMatchingRule — pair feeder with rule by element-bag overlap", () => {
  it("returns null when no rules supplied", () => {
    expect(findMatchingRule(lhs("['A']"), [])).toBeNull();
  });

  it("returns null when feeder has no concrete elements", () => {
    expect(findMatchingRule(lhs("[]"), [lhs("['A']")])).toBeNull();
  });

  it("returns null when no rule shares any element with the feeder", () => {
    const rules = [lhs("['X','Y']"), lhs("['M','N']")];
    expect(findMatchingRule(lhs("['A','B']"), rules)).toBeNull();
  });

  it("picks the rule with the highest element-bag overlap", () => {
    const r1 = lhs("['A','B']"); // overlap 1
    const r2 = lhs("['A','B','C']"); // overlap 2 (best)
    const r3 = lhs("['X']"); // overlap 0
    const match = findMatchingRule(lhs("['B','C']"), [r1, r2, r3]);
    expect(match).toBe(r2);
  });

  it("matches via qualified element values (Dim:Elem)", () => {
    const rules = [lhs("['Measure:OpenDays']")];
    const feeder = lhs("['Measure:OpenDays']");
    expect(findMatchingRule(feeder, rules)).toBe(rules[0]);
  });

  it("ties broken deterministically — returns the first rule with the top overlap", () => {
    const r1 = lhs("['A','B']");
    const r2 = lhs("['A','B']");
    const match = findMatchingRule(lhs("['A','B']"), [r1, r2]);
    expect(match).toBe(r1);
  });
});

describe("detectBroaderThanMatchedRule — S1 rule-pairing variant", () => {
  it("flags when feeder pins fewer dims than its matched rule", () => {
    const feeder = lhs("['A']"); // 1 pinned
    const rule = lhs("['A','B']"); // 2 pinned
    expect(detectBroaderThanMatchedRule(feeder, rule)).toBe(true);
  });

  it("does NOT flag when feeder and rule pin equally (idiomatic 1:1 N: pattern)", () => {
    const feeder = lhs("['Measure:WorkDays']");
    const rule = lhs("['Measure:OpenDays']");
    expect(detectBroaderThanMatchedRule(feeder, rule)).toBe(false);
  });

  it("does NOT flag when feeder pins MORE than its rule (feeder is narrower → safe)", () => {
    const feeder = lhs("['Account:X','Measure:Y']"); // 2
    const rule = lhs("['Measure:Y']"); // 1
    expect(detectBroaderThanMatchedRule(feeder, rule)).toBe(false);
  });

  it("returns false on empty feeder bracket (S4 territory)", () => {
    expect(detectBroaderThanMatchedRule(lhs("[]"), lhs("['A']"))).toBe(false);
  });
});

describe("detectOrphanFeeder — S6", () => {
  it("flags feeder whose elements share nothing with any rule LHS", () => {
    const ruleLhs = [lhs("['X','Y','Z']")];
    const feeder = lhs("['A','B','C']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(true);
  });

  it("does not flag feeder that shares at least one element with a rule", () => {
    const ruleLhs = [lhs("['X','Y','Z']")];
    const feeder = lhs("['Z','A']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(false);
  });

  it("checks across all rules, not just the first", () => {
    const ruleLhs = [lhs("['X','Y']"), lhs("['M','N']")];
    const feeder = lhs("['N']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(false);
  });

  it("returns false when feeder bracket has no entries (wildcard handled by S4)", () => {
    const ruleLhs = [lhs("['X','Y']")];
    expect(detectOrphanFeeder(lhs("[]"), ruleLhs)).toBe(false);
  });

  it("matches via qualified element ('Dim':'Elem') too", () => {
    const ruleLhs = [lhs("['Year':'2026','Sales']")];
    const feeder = lhs("['Year':'2026']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(false);
  });
});

describe("collectElementBag — bag semantics", () => {
  it("collects positional elements", () => {
    expect([...collectElementBag(lhs("['A','B','C']"))]).toEqual(
      expect.arrayContaining(["A", "B", "C"]),
    );
  });

  it("collects qualified element values", () => {
    expect([...collectElementBag(lhs("['Year':'2026','Sales']"))]).toEqual(
      expect.arrayContaining(["2026", "Sales"]),
    );
  });

  it("expands set-form elements", () => {
    expect([...collectElementBag(lhs("['Year':{'2025','2026'}]"))]).toEqual(
      expect.arrayContaining(["2025", "2026"]),
    );
  });
});

function makeCache(
  table: Record<string, Record<string, "Numeric" | "Consolidated" | "String">>,
): ElementTypeCache {
  const hier = {
    getElementTypes: vi.fn(async (dim: string, hierName: string) => {
      const key = `${dim}|${hierName}`;
      const elems = table[key] ?? {};
      return Object.entries(elems).map(([name, type]) => ({ name, type }));
    }),
  };
  return new ElementTypeCache(hier);
}

describe("detectFeederToConsolidated — S2", () => {
  it("flags positional feeder with consolidated element", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated", DE: "Numeric" },
      "Time|Time": { "2026": "Numeric" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Total','2026']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("does not flag positional feeder when all elements are leaves", async () => {
    const cache = makeCache({
      "Region|Region": { DE: "Numeric" },
      "Time|Time": { "2026": "Numeric" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['DE','2026']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toBeNull();
  });

  it("flags qualified feeder with consolidated element", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Region':'Total']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("flags set-form feeder when any element is consolidated", async () => {
    const cache = makeCache({
      "Region|Region": { DE: "Numeric", Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Region':{'DE','Total'}]"),
      ["Region"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("returns null on empty bracket (S4 territory)", async () => {
    const cache = makeCache({});
    expect(
      await detectFeederToConsolidated(lhs("[]"), ["Region"], cache),
    ).toBeNull();
  });

  it("returns null when cubeDimNames is empty (resolver missing)", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Total']"),
      [],
      cache,
    );
    expect(result).toBeNull();
  });

  it("skips positional entries past cubeDimNames length", async () => {
    const cache = makeCache({
      "Region|Region": { DE: "Numeric" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['DE','SomethingExtra']"),
      ["Region"],
      cache,
    );
    expect(result).toBeNull();
  });

  it("handles 'Dim:Hier' qualified form", async () => {
    const cache = makeCache({
      "Region|RegionAlt": { Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Region:RegionAlt':'Total']"),
      ["Region"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("returns first consolidated element on multi-flag rows", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated" },
      "Time|Time": { Y: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Total','Y']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("returns null when element-type lookup fails (degrade gracefully)", async () => {
    const cache = makeCache({});
    const result = await detectFeederToConsolidated(
      lhs("['Total']"),
      ["Region"],
      cache,
    );
    expect(result).toBeNull();
  });
});

describe("detectDbFeederWithoutSkipcheck — S5", () => {
  it("returns null when line has no DB() call", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => ['Other','X','Y'];",
      () => true,
    );
    expect(result).toBeNull();
  });

  it("flags DB() to a cube without skipcheck", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB('OtherCube','X','Y');",
      (name) => (name === "OtherCube" ? false : null),
    );
    expect(result).toBe("OtherCube");
  });

  it("returns null when DB() target has skipcheck", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB('OtherCube','X','Y');",
      (name) => (name === "OtherCube" ? true : null),
    );
    expect(result).toBeNull();
  });

  it("returns null when DB() target unknown (not in scan scope)", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB('UnknownCube','X','Y');",
      () => null,
    );
    expect(result).toBeNull();
  });

  it("skips DB() with dynamic (non-string-literal) cube name", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB(sCube,'X','Y');",
      () => false,
    );
    expect(result).toBeNull();
  });

  it("returns first offending target across multiple DB() calls", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A'] => DB('CubeOK','X') * DB('CubeBad','Y');",
      (name) => {
        if (name === "CubeOK") return true;
        if (name === "CubeBad") return false;
        return null;
      },
    );
    expect(result).toBe("CubeBad");
  });

  it("ignores DB() inside string literals (extractor handles this)", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => 'not a DB call' ;",
      () => false,
    );
    expect(result).toBeNull();
  });
});
