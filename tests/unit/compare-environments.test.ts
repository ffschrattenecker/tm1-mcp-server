import { describe, expect, it } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerCompareEnvironments } from "../../src/tools/analysis/compare-environments.js";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { peerRunner } from "../helpers/peer-tool.js";

interface Model {
  cubes: Record<string, { dims: string[]; rules: string }>;
  processes: Record<
    string,
    { prolog: string; params?: Record<string, string>; view?: string }
  >;
  chores: Record<string, { active: boolean; process: string }>;
  dims: Record<
    string,
    { hierarchies: string[]; count: number; edges?: number }
  >;
}

function client(m: Model): TM1Client {
  return contractCheckedClient({
    cubes: {
      getAllRules: async () =>
        Object.entries(m.cubes).map(([cubeName, c]) => ({
          cubeName,
          rulesText: c.rules,
          skipCheck: false,
          dimensions: c.dims,
        })),
    },
    processes: {
      fetchForCallgraph: async () =>
        Object.entries(m.processes).map(([name, p]) => ({
          name,
          prolog: p.prolog,
          metadata: "",
          data: "",
          epilog: "",
          parameters: Object.keys(p.params ?? {}),
          parameterDefaults: new Map(Object.entries(p.params ?? {})),
        })),
      listDataSources: async () =>
        Object.entries(m.processes).map(([name, p]) =>
          p.view
            ? { name, type: "TM1CubeView", sourceName: "Sales", view: p.view }
            : { name, type: "None" },
        ),
    },
    chores: {
      list: async () =>
        Object.entries(m.chores).map(([name, c]) => ({
          name,
          active: c.active,
          startTime: "2026-01-01T00:00Z",
          frequency: "P1D",
          processes: [{ name: c.process, parameters: {} }],
        })),
    },
    dimensions: {
      list: async () =>
        Object.entries(m.dims).map(([name, d]) => ({
          name,
          hierarchies: d.hierarchies,
          elementCounts: { [d.hierarchies[0]]: d.count },
        })),
    },
    hierarchies: {
      getStructure: async (dim: string) => ({
        elements: [{ name: "Total", type: "Consolidated" }],
        edges: Array.from({ length: m.dims[dim].edges ?? 0 }, (_, i) => ({
          parent: "Total",
          child: `E${i}`,
          weight: 1,
        })),
      }),
    },
  } as unknown as TM1Client);
}

const prod: Model = {
  cubes: {
    Sales: { dims: ["Version", "Measure"], rules: "SKIPCHECK;\n['A'] = 1;" },
    Old: { dims: ["Version"], rules: "" },
  },
  processes: {
    "Load.Sales": { prolog: "nX = 1;", params: { pYear: "2026" } },
    Same: { prolog: "x = 1;" },
    ViewLoad: { prolog: "", view: "Actuals" },
  },
  chores: { Nightly: { active: true, process: "Load.Sales" } },
  dims: {
    Region: { hierarchies: ["Region"], count: 10, edges: 3 },
    "}Clients": { hierarchies: ["}Clients"], count: 2 },
  },
};

const dev: Model = {
  cubes: {
    // Same rules modulo line endings; differs only in dimension order.
    Sales: {
      dims: ["Measure", "Version"],
      rules: "SKIPCHECK;\r\n['A'] = 1;\r\n",
    },
    New: { dims: ["Version"], rules: "" },
  },
  processes: {
    "load.sales": { prolog: "nX = 2;", params: { pYear: "2027" } },
    Same: { prolog: "x = 1;" },
    // Same code, different source view: only the datasource aspect differs.
    ViewLoad: { prolog: "", view: "Budget" },
  },
  chores: { Nightly: { active: false, process: "Load.Sales" } },
  dims: {
    region: { hierarchies: ["Region"], count: 10, edges: 4 },
    "}Clients": { hierarchies: ["}Clients"], count: 5 },
  },
};

interface Section {
  countA: number;
  identical: number;
  counts: Record<string, number>;
  onlyInA: string[];
  onlyInB: string[];
  differs: Array<{ name: string; aspects: string[] }>;
  drillDown?: string;
}

interface Result {
  connectionA: string;
  connectionB: string;
  identical: boolean;
  cubes: Section;
  processes: Section;
  chores: Section;
  dimensions: Section;
}

describe("tm1_compare_environments", () => {
  const run = peerRunner(registerCompareEnvironments, {
    dev: client(dev),
    prod: client(prod),
  });

  it("reports one-sided and differing objects per type, with drill-downs", async () => {
    const r = await run<Result>({
      connection: "prod",
      connectionB: "dev",
    });
    expect(r).toMatchObject({
      connectionA: "prod",
      connectionB: "dev",
      identical: false,
    });
    expect(r.cubes).toMatchObject({
      onlyInA: ["Old"],
      onlyInB: ["New"],
      differs: [{ name: "Sales", aspects: ["dimensions"] }],
      drillDown: "tm1_diff_cube_rules",
    });
    expect(r.processes).toMatchObject({
      identical: 1,
      differs: [
        { name: "Load.Sales", aspects: ["code", "parameters"] },
        { name: "ViewLoad", aspects: ["dataSource"] },
      ],
      drillDown: "tm1_diff_processes",
    });
    expect(r.chores.differs).toEqual([
      { name: "Nightly", aspects: ["active"] },
    ]);
    // Control dimensions are left out by default; element counts match.
    expect(r.dimensions).toMatchObject({
      countA: 1,
      identical: 1,
      differs: [],
    });
  });

  it("deep mode catches a structural change the element count misses", async () => {
    const r = await run<Result>({
      connection: "prod",
      connectionB: "dev",
      objectTypes: ["dimensions"],
      deep: true,
    });
    expect(r.dimensions.differs).toEqual([
      { name: "Region", aspects: ["structure"] },
    ]);
    expect(r).not.toHaveProperty("cubes");
  });

  it("deep mode reads only the hierarchies nameRegex selects", async () => {
    const reads: string[] = [];
    const counting = (m: Model): TM1Client => {
      const c = client(m);
      const getStructure = c.hierarchies.getStructure.bind(c.hierarchies);
      return {
        ...c,
        dimensions: c.dimensions,
        hierarchies: {
          getStructure: (dim: string, hier: string) => {
            reads.push(dim);
            return getStructure(dim, hier);
          },
        },
      } as unknown as TM1Client;
    };
    const model: Model = {
      ...prod,
      dims: {
        Region: { hierarchies: ["Region"], count: 1 },
        Product: { hierarchies: ["Product"], count: 1 },
      },
    };
    const runCounting = peerRunner(registerCompareEnvironments, {
      dev: counting(model),
      prod: counting(model),
    });
    await runCounting({
      connection: "prod",
      connectionB: "dev",
      objectTypes: ["dimensions"],
      nameRegex: "^region$",
      deep: true,
    });
    expect(reads).toEqual(["Region", "Region"]);
  });

  it("ignores a leading Sandboxes dimension (EnableSandboxDimension)", async () => {
    const cube = { dims: ["Version", "Measure"], rules: "" };
    const sandboxed = {
      ...prod,
      cubes: { Sales: { ...cube, dims: ["Sandboxes", ...cube.dims] } },
    };
    const r = await peerRunner(registerCompareEnvironments, {
      dev: client(sandboxed),
      prod: client({ ...prod, cubes: { Sales: cube } }),
    })<Result>({
      connection: "dev",
      connectionB: "prod",
      objectTypes: ["cubes"],
    });
    expect(r.cubes).toMatchObject({ identical: 1, differs: [] });
  });

  it("filters by nameRegex and caps lists", async () => {
    const r = await run<Result>({
      connection: "prod",
      connectionB: "dev",
      objectTypes: ["cubes"],
      nameRegex: "^(old|new)$",
      limit: 1,
    });
    expect(r.cubes).toMatchObject({
      counts: { onlyInA: 1, onlyInB: 1, differs: 0 },
      onlyInA: ["Old"],
    });
  });

  it("is identical when a connection is compared with itself", async () => {
    const r = await run<Result>({ connection: "dev" });
    expect(r.identical).toBe(true);
  });
});
