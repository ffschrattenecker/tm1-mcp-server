import { describe, it, expect } from "vitest";
import { checkProcessRefs } from "../../src/lib/process-refs.js";

const catalogue = (cubes: string[], dims: string[]) => ({
  cubes: { list: async () => cubes.map((name) => ({ name })) },
  dimensions: { list: async () => dims.map((name) => ({ name })) },
});

describe("checkProcessRefs", () => {
  it("flags a cube that does not exist, with tab and line", async () => {
    const r = await checkProcessRefs(catalogue(["Sales"], []), {
      prolog: "x = 1;\nCellPutN(1, 'Sales Plan', 'a', 'b');",
    });
    expect(r.issues).toEqual([
      {
        kind: "cube",
        name: "Sales Plan",
        tab: "prolog",
        line: 2,
        context: "CellPutN(1, 'Sales Plan', 'a', 'b');",
      },
    ]);
    expect(r.tabsChecked).toEqual(["prolog"]);
  });

  it("does not flag existence probes or names the code creates", async () => {
    const r = await checkProcessRefs(catalogue([], []), {
      prolog: [
        "sDim = 'ZZ_New';",
        "IF(DimensionExists(sDim) = 0);",
        "  DimensionCreate(sDim);",
        "ENDIF;",
        "IF(CubeExists('ZZ_Cube') = 0);",
        "  CubeCreate('ZZ_Cube', sDim, sDim);",
        "ENDIF;",
        "DimensionElementInsertDirect(sDim, '', 'A', 'N');",
        "CellPutN(1, 'ZZ_Cube', 'A', 'A');",
      ].join("\n"),
    });
    expect(r.issues).toEqual([]);
    expect(r.cubeRefsScanned).toBe(1);
    expect(r.dimensionRefsScanned).toBe(1);
  });

  it("still flags a probe-guarded name the code never creates", async () => {
    const r = await checkProcessRefs(catalogue([], []), {
      data: "IF(DimensionExists('Region') = 1);\n  DimIx('Region', vEl);\nENDIF;",
    });
    expect(r.issues.map((i) => i.name)).toEqual(["Region"]);
  });

  it("reports partial coverage when a name comes from a parameter", async () => {
    const r = await checkProcessRefs(catalogue(["Sales"], []), {
      prolog: "CellPutN(1, pCube, 'a');\nCellGetN(pOther, 'a');",
      epilog: "CellGetN('Sales', 'a');",
    });
    expect(r.issues).toEqual([]);
    expect(r.unresolvableArgs).toBe(2);
    expect(r.partial).toBe(true);
    expect(r.tabsChecked).toEqual(["prolog", "epilog"]);
  });

  it("is complete when every name resolves", async () => {
    const r = await checkProcessRefs(catalogue(["Sales"], []), {
      prolog: "sC = 'Sales';\nCellGetN(sC, 'a');",
    });
    expect(r.partial).toBe(false);
    expect(r.unresolvableArgs).toBe(0);
  });
});

// Element literals in cell calls. The catalogue models TM1's own resolution:
// names compare ignoring case and spaces, and an alias resolves.
describe("checkProcessRefs — element literals", () => {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  function elementCatalogue(opts: {
    cubes: Record<string, string[]>;
    members: Record<string, string[]>; // "Dim" or "Dim:Hier" → names + aliases
    lookups?: string[];
    failOn?: string;
  }) {
    // A class instance whose methods need `this`, like TM1Client's services:
    // calling a detached method fails here just as it does live.
    class Cubes {
      constructor(private readonly byName: Record<string, string[]>) {}
      list() {
        return Promise.resolve(
          Object.keys(this.byName).map((name) => ({ name })),
        );
      }
      getDimensionNames(c: string) {
        return Promise.resolve(this.byName[c]);
      }
    }
    return {
      cubes: new Cubes(opts.cubes),
      dimensions: {
        list: async () =>
          [...new Set(Object.values(opts.cubes).flat())].map((name) => ({
            name,
          })),
      },
      elements: {
        exists: async (dim: string, hier: string, el: string) => {
          opts.lookups?.push(`${hier === dim ? dim : `${dim}:${hier}`}/${el}`);
          if (opts.failOn === el) throw new Error("401 unauthorized");
          const key = hier === dim ? dim : `${dim}:${hier}`;
          return (opts.members[key] ?? []).some((m) => norm(m) === norm(el));
        },
      },
    };
  }
  const SALES = { Sales: ["Sandboxes", "Region", "Measure"] };
  const MEMBERS = {
    Region: ["North America", "NA", "Europe"],
    Measure: ["Amount"],
  };

  it("flags a missing element and names its dimension", async () => {
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS }),
      { prolog: "CellPutN(1, 'Sales', 'Asia', 'Amount');" },
    );
    expect(r.issues).toEqual([
      {
        kind: "element",
        name: "Asia",
        dimension: "Region",
        tab: "prolog",
        line: 1,
        context: "CellPutN(1, 'Sales', 'Asia', 'Amount');",
      },
    ]);
    expect(r.elementRefsScanned).toBe(2);
    expect(r.partial).toBe(false);
  });

  it("skips Sandboxes, resolves aliases and ignores case/spaces", async () => {
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS }),
      {
        prolog: [
          "CellPutN(1, 'Sales', 'NA', 'Amount');",
          "x = CellGetN('Sales', 'northamerica', 'AMOUNT');",
          "sM = 'Amount';",
          "CellIncrementN(1, 'Sales', 'Europe', sM);",
        ].join("\n"),
      },
    );
    expect(r.issues).toEqual([]);
  });

  it("does not check variables, and they do not make the report partial", async () => {
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS }),
      { data: "CellPutN(vValue, 'Sales', vRegion, 'Amount');" },
    );
    expect(r.issues).toEqual([]);
    expect(r.elementRefsScanned).toBe(1);
    expect(r.partial).toBe(false);
  });

  it("excuses elements the code inserts, and all of a dimension it inserts computed names into", async () => {
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS }),
      {
        metadata: [
          "DimensionElementInsert('Region', '', 'Asia', 'N');",
          "HierarchyElementInsert('Measure', 'Measure', '', vMeasure, 'N');",
        ].join("\n"),
        data: "CellPutN(1, 'Sales', 'Asia', 'Qty');",
      },
    );
    expect(r.issues).toEqual([]);
  });

  it("flags a call whose element count does not match the cube, without looking its elements up", async () => {
    const lookups: string[] = [];
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS, lookups }),
      {
        prolog: [
          "CellPutN(1, 'Sales', 'Base', 'Asia', 'Amount');",
          "x = CellGetN('Sales', 'Europe');",
        ].join("\n"),
      },
    );
    expect(r.issues).toEqual([
      {
        kind: "elementCount",
        name: "Sales",
        expected: 2,
        got: 3,
        tab: "prolog",
        line: 1,
        context: "CellPutN(1, 'Sales', 'Base', 'Asia', 'Amount');",
      },
      {
        kind: "elementCount",
        name: "Sales",
        expected: 2,
        got: 1,
        tab: "prolog",
        line: 2,
        context: "x = CellGetN('Sales', 'Europe');",
      },
    ]);
    expect(lookups).toEqual([]);
  });

  it("checks the element count even when a computed dimension name stops the element lookups", async () => {
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS }),
      {
        metadata: "DimensionElementInsert(pDim, '', vEl, 'N');",
        data: "CellPutN(vValue, 'Sales', vRegion);",
      },
    );
    expect(r.issues.map((i) => [i.kind, i.expected, i.got])).toEqual([
      ["elementCount", 2, 1],
    ]);
  });

  it("reads 'Hierarchy:Element' against that hierarchy", async () => {
    const r = await checkProcessRefs(
      elementCatalogue({
        cubes: SALES,
        members: { ...MEMBERS, "Region:Alt": ["Asia"] },
      }),
      {
        prolog: [
          "CellPutN(1, 'Sales', 'Alt:Asia', 'Amount');",
          "CellPutN(1, 'Sales', 'Alt:Mars', 'Amount');",
        ].join("\n"),
      },
    );
    expect(r.issues.map((i) => i.name)).toEqual(["Alt:Mars"]);
  });

  it("looks each distinct pair up once and caps the lookups (the rest is partial)", async () => {
    const lookups: string[] = [];
    const calls = Array.from(
      { length: 205 },
      (_, i) => `CellPutN(1, 'Sales', 'R${i}', 'Amount');`,
    );
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS, lookups }),
      { prolog: calls.join("\n") },
    );
    expect(lookups).toHaveLength(200);
    expect(r.elementRefsScanned).toBe(200);
    expect(r.unresolvableArgs).toBe(6);
    expect(r.partial).toBe(true);
  });

  it("surfaces a failing lookup instead of calling the element missing", async () => {
    await expect(
      checkProcessRefs(
        elementCatalogue({ cubes: SALES, members: MEMBERS, failOn: "Europe" }),
        { prolog: "CellPutN(1, 'Sales', 'Europe', 'Amount');" },
      ),
    ).rejects.toThrow(/401/);
  });

  it("skips element checks for a cube the code creates", async () => {
    const lookups: string[] = [];
    const r = await checkProcessRefs(
      elementCatalogue({ cubes: SALES, members: MEMBERS, lookups }),
      {
        prolog: [
          "CubeCreate('Sales', 'Region', 'Measure');",
          "CellPutN(1, 'Sales', 'Asia', 'Amount');",
        ].join("\n"),
      },
    );
    expect(r.issues).toEqual([]);
    expect(lookups).toEqual([]);
  });
});

// An insert that is queued until its tab ends, then an attribute write on the
// same element in that tab: fails on the run that creates the element.
describe("checkProcessRefs — attribute write on an uncommitted insert", () => {
  const noServer = catalogue([], ["Region", "Product"]);

  it("flags it in the Prolog with literals and in the Metadata with variables", async () => {
    const r = await checkProcessRefs(noServer, {
      prolog: [
        "DimensionElementInsert('Region', '', 'Asia', 'N');",
        "AttrPutS('Asien', 'Region', 'Asia', 'German');",
      ].join("\n"),
      metadata: [
        "HierarchyElementInsert('Product', 'Product', '', vProduct, 'N');",
        "ElementAttrPutS(vDesc, 'Product', 'Product', vProduct, 'Description');",
      ].join("\n"),
    });
    expect(r.issues).toEqual([
      {
        kind: "uncommittedElement",
        name: "Asia",
        dimension: "Region",
        tab: "prolog",
        line: 2,
        context: "AttrPutS('Asien', 'Region', 'Asia', 'German');",
      },
      {
        kind: "uncommittedElement",
        name: "vProduct",
        dimension: "Product",
        tab: "metadata",
        line: 2,
        context:
          "ElementAttrPutS(vDesc, 'Product', 'Product', vProduct, 'Description');",
      },
    ]);
  });

  it("matches names the way TM1 does, and through literal-bound variables", async () => {
    const r = await checkProcessRefs(noServer, {
      prolog: [
        "sDim = 'Region';",
        "DimensionElementInsert(sDim, '', 'North America', 'N');",
        "AttrPutN(1, 'region', 'NorthAmerica', 'Flag');",
      ].join("\n"),
    });
    expect(r.issues.map((i) => i.kind)).toEqual(["uncommittedElement"]);
  });

  it("does not flag a Direct insert, a later tab, an earlier write or another element", async () => {
    const r = await checkProcessRefs(noServer, {
      prolog: [
        "AttrPutS('x', 'Region', 'Asia', 'German');",
        "DimensionElementInsert('Region', '', 'Asia', 'N');",
        "DimensionElementInsertDirect('Region', '', 'Europe', 'N');",
        "AttrPutS('Europa', 'Region', 'Europe', 'German');",
        "AttrPutS('x', 'Region', 'Africa', 'German');",
      ].join("\n"),
      metadata: "DimensionElementInsert('Product', '', vProduct, 'N');",
      data: "AttrPutS(vDesc, 'Product', vProduct, 'Description');",
      epilog: [
        "DimensionElementInsert('Region', '', 'Oceania', 'N');",
        "AttrPutS('Ozeanien', 'Region', 'Oceania', 'German');",
      ].join("\n"),
    });
    expect(r.issues).toEqual([]);
  });
});

describe("checkProcessRefs — TM1 name identity", () => {
  it("matches a cube or dimension name ignoring case and spaces, as TM1 does", async () => {
    const r = await checkProcessRefs(catalogue(["TotalYear"], ["TotalYear"]), {
      prolog: "CellPutN(1, 'Total Year', 'a');\nDimIx('Total Year', 'a');",
    });
    expect(r.issues).toEqual([]);
  });

  it("excuses a name the code creates under a spelling that differs only by case and spaces", async () => {
    const r = await checkProcessRefs(catalogue([], []), {
      prolog:
        "CubeCreate('Total Year', 'a', 'b');\nCellPutN(1, 'TotalYear', 'a');",
    });
    expect(r.issues).toEqual([]);
  });
});
