import { describe, it, expect } from "vitest";
import {
  buildReferenceIndex,
  elementKey,
  extractTiReferences,
} from "../../src/lib/callgraph/referenceIndex.js";

// Shared minimal deps (mirror tests/unit/callgraph-global-ranking.test.ts shape:
// only process code varies; cubes/chores empty).
function indexOf(prolog: string) {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      { name: "P", prolog, metadata: "", data: "", epilog: "", parameters: [] },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

describe("rules dimension references", () => {
  const rulesIndex = (rulesText: string) =>
    buildReferenceIndex({
      fetchProcesses: async () => [],
      fetchCubesWithRules: async () => [{ cubeName: "Sales", rulesText }],
      fetchChores: async () => [],
    });

  it("finds the qualified dimension in a mixed qualified and positional bracket", async () => {
    const index = await rulesIndex("['Year':'2026','Sales'] = N: 1;");
    expect(index.byDim.get("year")?.map((r) => r.sourceName)).toEqual([
      "Sales",
    ]);
  });

  it("reads '' escapes in dimension names", async () => {
    const index = await rulesIndex("['It''s':'A''B'] = N: 1;");
    expect(index.byDim.has("it's")).toBe(true);
  });

  it("ignores a bracket inside a trailing comment", async () => {
    const index = await rulesIndex("['A'] = N: 1; # see ['Hidden':'x']");
    expect(index.byDim.has("hidden")).toBe(false);
  });
});

describe("byElement reverse index", () => {
  it("indexes a literal SubsetElementInsert element under (dim, element)", async () => {
    const index = await indexOf(
      "SubsetCreate('sTmp','Kanaele',1);\nSubsetElementInsert('Kanaele','sTmp','SuKanaele_C',1);",
    );
    const refs = index.byElement.get(elementKey("Kanaele", "SuKanaele_C"));
    expect(refs).toBeDefined();
    expect(
      refs!.map((r) => ({
        kind: r.targetKind,
        dim: r.dimension,
        name: r.targetName,
        src: r.sourceName,
      })),
    ).toEqual([
      {
        kind: "element",
        dim: "Kanaele",
        name: "SuKanaele_C",
        src: "P",
      },
    ]);
  });
});

describe("extractTiReferences — element refs from subset-membership calls", () => {
  it("emits an element ref (with dimension) for SubsetElementInsert", () => {
    const refs = extractTiReferences(
      "SubsetElementInsert('Kanaele','sTmp','SuKanaele_C',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el).toEqual([
      {
        line: 0,
        funcName: "SubsetElementInsert",
        targetKind: "element",
        targetName: "SuKanaele_C",
        dimension: "Kanaele",
        subset: "sTmp",
        snippet: "SubsetElementInsert('Kanaele','sTmp','SuKanaele_C',1);",
        params: undefined,
      },
    ]);
  });

  it("handles SubsetElementAdd arg order (dim at index 0)", () => {
    const refs = extractTiReferences(
      "SubsetElementAdd('Kunde','sTmp','K100');",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName }))).toEqual([
      { dim: "Kunde", name: "K100" },
    ]);
  });

  it("resolves a variable dimension via live-var tracking", () => {
    const refs = extractTiReferences(
      "csDim = 'Kanaele';\nSubsetElementInsert(csDim,'sTmp','SuKanaele_C',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName }))).toEqual([
      { dim: "Kanaele", name: "SuKanaele_C" },
    ]);
  });

  it("surfaces a non-literal element arg as unresolved, not a resolved ref", () => {
    const unresolvedElem: unknown[] = [];
    const refs = extractTiReferences(
      "SubsetElementInsert('Kanaele','sTmp',CellGetS('C','x'),1);",
      undefined,
      undefined,
      undefined,
      unresolvedElem as never,
    );
    expect(refs.filter((r) => r.targetKind === "element")).toEqual([]);
    expect(unresolvedElem).toEqual([
      {
        line: 0,
        funcName: "SubsetElementInsert",
        dimension: "Kanaele",
        expr: "CellGetS('C','x')",
        snippet: "SubsetElementInsert('Kanaele','sTmp',CellGetS('C','x'),1);",
        reason: "dynamic",
      },
    ]);
  });
});

describe("buildReferenceIndex — unresolvedElementRefsBySourceProcess", () => {
  it("buckets a dynamic element arg per source process", async () => {
    const index = await indexOf(
      "SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);",
    );
    expect(index.unresolvedElementRefsBySourceProcess.get("p")).toEqual([
      {
        section: "prolog",
        line: 0,
        funcName: "SubsetElementInsert",
        dimension: "Kunde",
        expr: "CellGetS('C','x')",
        snippet: "SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);",
        reason: "dynamic",
      },
    ]);
  });
});

describe("element ref carries subset handle", () => {
  it("attaches resolved subset name SubsetElementInsert", () => {
    const refs = extractTiReferences(
      "SubsetElementInsert('Currency','sTmp','USD',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(
      el.map((r) => ({
        dim: r.dimension,
        name: r.targetName,
        subset: r.subset,
      })),
    ).toEqual([{ dim: "Currency", name: "USD", subset: "sTmp" }]);
  });
  it("resolves subset handle from variable", () => {
    const refs = extractTiReferences(
      "csSub='sTmp';\nSubsetElementAdd('Currency',csSub,'USD');",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el[0].subset).toBe("sTmp");
  });
});
