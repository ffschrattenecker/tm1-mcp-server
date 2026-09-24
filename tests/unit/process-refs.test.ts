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
