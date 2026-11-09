import { describe, it, expect } from "vitest";
import { registerAuditFeeders } from "../../src/tools/analysis/audit-feeders.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { captureParsedTool } from "../helpers/client-harness.js";

interface FakeArgs {
  productVersion: string;
  rules?: Array<{ cubeName: string; rulesText: string; skipCheck: boolean }>;
  /** Map of cubeName -> ordered dimension names. Missing entry => getDimensionNames throws. */
  dims?: Record<string, string[]>;
  /**
   * Make the bulk rules request answer without the Dimensions expansion, so
   * the tool has to fall back to the per-cube getDimensionNames path.
   */
  expandOmitsDimensions?: boolean;
  /** Every cube name getDimensionNames was asked for, in call order. */
  dimCallLog?: string[];
  /** Map of "dim|hierarchy" -> { elemName: type } for the element-type cache. */
  elements?: Record<
    string,
    Record<string, "Numeric" | "Consolidated" | "String">
  >;
  /** Map of cubeName -> }StatsByCube measure values (drives runtime mode). Throws on miss. */
  cubeStats?: Record<string, Record<string, number>>;
  /** Connection major version, as TM1Client.version reports it. */
  version?: 11 | 12;
  /** When set, every }StatsByCube MDX rejects with this (server-wide failure). */
  statsFailure?: Error;
  /** Answer of the structural existence probe `cubes.exists('}StatsByCube')`. */
  statsCubeExists?: boolean;
}

function makeAuditFeedersClientStub(args: FakeArgs) {
  const isControl = (n: string) => n.startsWith("}");
  return {
    version: args.version ?? 11,
    server: { getInfo: async () => ({ productVersion: args.productVersion }) },
    cubes: {
      getAllRules: async (
        arg:
          | boolean
          | { includeControl?: boolean; withDimensions?: boolean } = false,
      ) => {
        const opts = typeof arg === "object" ? arg : { includeControl: arg };
        const all = args.rules ?? [];
        const visible = opts.includeControl
          ? all
          : all.filter((r) => !isControl(r.cubeName));
        if (!opts.withDimensions || args.expandOmitsDimensions) return visible;
        // Mirror the server: $expand carries the dimension names on the same
        // response, so the tool never has to ask per cube.
        return visible.map((r) => {
          const dims = args.dims?.[r.cubeName];
          return dims ? { ...r, dimensions: dims } : r;
        });
      },
      getDimensionNames: async (cubeName: string) => {
        args.dimCallLog?.push(cubeName);
        const dims = args.dims?.[cubeName];
        if (!dims) throw new Error(`no dims for ${cubeName}`);
        return dims;
      },
      // Structural existence probe the fetcher runs when the stats MDX fails.
      // Default true: a plain MDX failure is then a per-cube error, exactly as
      // before this probe existed.
      exists: async () => args.statsCubeExists !== false,
    },
    hierarchies: {
      getElementTypes: async (dim: string, hier: string) => {
        const key = `${dim}|${hier}`;
        const elems = args.elements?.[key] ?? {};
        return Object.entries(elems).map(([name, type]) => ({ name, type }));
      },
    },
    cells: {
      executeMdx: async (mdx: string) => {
        if (args.statsFailure !== undefined) throw args.statsFailure;
        // Extract cube name from `{[}PerfCubes].[}PerfCubes].[<name>]}`.
        const m = mdx.match(/\.\[}PerfCubes]\.\[([^\]]+)]/);
        if (!m) throw new Error(`fake executeMdx: cannot parse cube from MDX`);
        const cubeName = m[1];
        const stats = args.cubeStats?.[cubeName];
        if (!stats)
          throw new Error(
            `fake executeMdx: }StatsByCube unavailable for ${cubeName}`,
          );
        const entries = Object.entries(stats);
        return {
          axes: [
            { tuples: [] },
            {
              tuples: entries.map(([name]) => ({
                members: [{ name }],
              })),
            },
          ],
          cells: entries.map(([, v]) => ({ value: v })),
        };
      },
    },
  } as unknown as Parameters<typeof registerAuditFeeders>[1];
}

/** Run tm1_audit_feeders against a stub and parse its JSON result. */
async function audit(
  tm1: ReturnType<typeof makeAuditFeedersClientStub>,
  args: Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const call = captureParsedTool(registerAuditFeeders, tm1);
  const raw = (await call(args)) as { content: Array<{ text: string }> };
  return JSON.parse(raw.content[0].text);
}

/** A feeder-bearing rules text with `skipcheck;` on the rule half. */
function cube(cubeName: string, body: string[], skipCheck = true) {
  return {
    cubeName,
    rulesText: [...(skipCheck ? ["skipcheck;"] : []), ...body].join("\n"),
    skipCheck,
  };
}

describe("tm1_audit_feeders tool", () => {
  it("returns pass when no cubes have feeders", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "Plain",
            rulesText: "skipcheck;\n['A']=N:1;",
            skipCheck: true,
          },
        ],
      }),
    );
    expect(out.status).toBe("pass");
    expect(out.scanned.cubes).toBe(1);
    expect(out.scanned.feederLines).toBe(0);
    expect(out.invalidCount).toBe(0);
  });

  it("every static rule reaches summary.byRule", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        dims: {
          Broad: ["D1", "D2", "D3", "D4", "D5"],
          Consol: ["Region"],
        },
        elements: { "Region|Region": { Total: "Consolidated", DE: "Numeric" } },
        rules: [
          // S1: feeder pins 2 dims, rule pins 5.
          cube("Broad", [
            "['A','B','C','D','E'] = N: 1;",
            "feeders;",
            "['A','B'] => ['E'];",
          ]),
          // S2: feeder sourced from a consolidated element.
          cube("Consol", [
            "['DE'] = N: 1;",
            "feeders;",
            "['Total'] => ['DE'];",
          ]),
          // S6: feeder elements never appear in any rule.
          cube("Orphany", [
            "['Real','Used'] = N: 1;",
            "feeders;",
            "['Ghost1','Ghost2'] => ['Ghost3'];",
          ]),
          // S4: wildcard bracket.
          cube("Wild", ["['A','B'] = N: 1;", "feeders;", "[] => ['B'];"]),
          // S5: DB() target without skipcheck.
          cube("Source", [
            "['A'] = N: 1;",
            "feeders;",
            "['A'] => DB('Target', 'X', 'Y');",
          ]),
          cube("Target", ["['X','Y'] = N: 1;"], false),
        ],
      }),
    );
    for (const rule of [
      "feeder_broader_than_rule",
      "feeder_to_consolidated",
      "orphan_feeder",
      "wildcard_bracket",
      "db_feeder_without_skipcheck",
    ]) {
      expect(out.summary.byRule[rule], rule).toBeGreaterThanOrEqual(1);
    }
  });

  it("skips S6 (orphan) for cross-cube DB-feeders too", async () => {
    // Cross-cube DB-feeder: target cells live in another cube. Local
    // orphan check can't see the matching rule there, so S6 must skip
    // these (S5 already covers DB-skipcheck risk).
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        dims: { Source: ["D1", "D2", "D3"] },
        rules: [
          {
            cubeName: "Source",
            rulesText: [
              "skipcheck;",
              "['Measure:Group'] = N: ['Measure:Local'] * 1;",
              "feeders;",
              "['Measure:Local'] => ['Measure:Group'];",
              "['Measure:Local'] => DB('Target', !D1, !D2, 'Local');",
            ].join("\n"),
            skipCheck: true,
          },
        ],
      }),
    );
    expect(out.summary.byRule.orphan_feeder).toBe(0);
  });

  it("skips S1 for cross-cube DB-feeders (rule lives in target cube)", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        dims: { Source: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] },
        rules: [
          {
            cubeName: "Source",
            rulesText: [
              "skipcheck;",
              "['Measure:Local'] = N: 1;",
              "feeders;",
              "['Measure:Local'] => DB('Target', !D1, !D2, !D3, !D4, !D5, !D6, 'Local');",
            ].join("\n"),
            skipCheck: true,
          },
        ],
      }),
    );
    expect(out.summary.byRule.feeder_broader_than_rule).toBe(0);
  });

  it("excludes control objects by default and includes them on opt-in", async () => {
    const tm1 = makeAuditFeedersClientStub({
      productVersion: "11.8",
      rules: [
        {
          cubeName: "}Hidden",
          rulesText: [
            "skipcheck;",
            "['A','B'] = N: 1;",
            "feeders;",
            "['A'] => ['B'];",
          ].join("\n"),
          skipCheck: true,
        },
      ],
    });
    expect((await audit(tm1, {})).scanned.cubes).toBe(0);
    expect((await audit(tm1, { includeControl: true })).scanned.cubes).toBe(1);
  });

  it("respects the cubes whitelist filter", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "WantThis",
            rulesText: "skipcheck;\n['A','B']=N:1;\nfeeders;\n['A']=>['B'];",
            skipCheck: true,
          },
          {
            cubeName: "SkipThis",
            rulesText: "skipcheck;\n['A','B']=N:1;\nfeeders;\n[]=>['B'];",
            skipCheck: true,
          },
        ],
      }),
      { cubes: ["WantThis"] },
    );
    expect(out.scanned.cubes).toBe(1);
    expect(
      out.findings.every((f: { cube: string }) => f.cube === "WantThis"),
    ).toBe(true);
  });

  it("honours topN cap and reports truncation", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "Big",
            rulesText: [
              "skipcheck;",
              "['A','B','C','D'] = N: 1;",
              "feeders;",
              ...Array.from({ length: 6 }, () => "[] => ['D'];"),
            ].join("\n"),
            skipCheck: true,
          },
        ],
      }),
      { topN: 3 },
    );
    expect(out.invalidCount).toBe(6);
    expect(out.findings).toHaveLength(3);
    expect(out.truncated.findings).toBe(true);
  });

  it("skips `=> [...]` continuation lines (multi-line feeder)", async () => {
    // Real-world cubes split a feeder across two lines; the second starts
    // with `=>`. The continuation must not be counted as a separate feeder.
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "MultiLine",
            rulesText: [
              "skipcheck;",
              "['A','B','C'] = N: 1;",
              "feeders;",
              "[]",
              "=> ['C'];",
            ].join("\n"),
            skipCheck: true,
          },
        ],
      }),
    );
    // One feeder logically (wildcard LHS line). Continuation line filtered out.
    expect(out.scanned.feederLines).toBe(1);
    expect(out.invalidCount).toBe(1);
    expect(out.findings[0].rule).toBe("wildcard_bracket");
  });

  const WILD_RULES = [
    {
      cubeName: "Wild",
      rulesText: "skipcheck;\n['A','B']=N:1;\nfeeders;\n[]=>['B'];",
      skipCheck: true,
    },
  ];
  const SPARSE_RULES = [
    {
      cubeName: "Sparse",
      rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
      skipCheck: true,
    },
  ];
  // 20,000x fed/populated: definite overfeeding.
  const SPARSE_STATS = {
    Sparse: {
      "Total Memory Used": 1_000_000,
      "Number of Populated Numeric Cells": 5,
      "Number of Fed Cells": 100_000,
    },
  };

  it.each([
    {
      label: "severityThreshold=none reports pass even with findings",
      args: { severityThreshold: "none" },
      rules: WILD_RULES,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      check: (out: any) => {
        expect(out.status).toBe("pass");
        expect(out.invalidCount).toBeGreaterThan(0);
      },
    },
    {
      label: "severityThreshold=evidence passes when only hints are present",
      args: { severityThreshold: "evidence" },
      rules: WILD_RULES,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      check: (out: any) => {
        expect(out.summary.bySeverity.hint).toBeGreaterThan(0);
        expect(out.summary.bySeverity.evidence).toBe(0);
        expect(out.status).toBe("pass");
      },
    },
    {
      label:
        "severityThreshold=evidence fails when runtime evidence is present",
      args: { mode: "both", severityThreshold: "evidence" },
      rules: SPARSE_RULES,
      cubeStats: SPARSE_STATS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      check: (out: any) => {
        expect(out.summary.bySeverity.evidence).toBeGreaterThan(0);
        expect(out.status).toBe("fail");
      },
    },
  ])("$label", async ({ args, rules, cubeStats, check }) => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules,
        ...(cubeStats ? { cubeStats } : {}),
      }),
      args,
    );
    check(out);
  });

  it("runtime mode skips static heuristics — emits only cube-level findings", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "Wild",
            rulesText: [
              "skipcheck;",
              "['A','B'] = N: 1;",
              "feeders;",
              "[] => ['B'];",
            ].join("\n"),
            skipCheck: true,
          },
        ],
        cubeStats: {
          Wild: {
            "Total Memory Used": 100,
            "Number of Populated Numeric Cells": 5,
            "Number of Fed Cells": 10,
          },
        },
      }),
      { mode: "runtime" },
    );
    // No wildcard finding emitted: static scan suppressed.
    expect(out.summary.byRule.wildcard_bracket).toBe(0);
    expect(out.scanned.feederLines).toBe(0);
    // Cube-level findings still run.
    expect(out.runtimeStats.Wild.available).toBe(true);
  });

  // Community calibration (tm1forum/Cubewise): only >= 50x is suspicious,
  // >= 100x definite. 11x (167M fed vs 15M populated) is normal fan-out.
  it.each([
    {
      label: "flags >= 100x fed/populated as evidence",
      populated: 5,
      fed: 100_000,
      severity: "evidence",
    },
    {
      label: "flags 50x-100x fed/populated as hint (suspicious, not definite)",
      populated: 1_000_000,
      fed: 60_000_000,
      severity: "hint",
    },
    {
      label: "does not flag fed/populated below 50x",
      populated: 15_000_000,
      fed: 167_000_000,
      severity: undefined,
    },
    {
      label:
        "ratio is null when populatedNumeric is zero (cross-cube-fed cube)",
      populated: 0,
      fed: 500_000,
      severity: undefined,
    },
  ])("runtime ratio: $label", async ({ populated, fed, severity }) => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: SPARSE_RULES.map((r) => ({ ...r, cubeName: "Ratio" })),
        cubeStats: {
          Ratio: {
            "Total Memory Used": 1_000_000,
            "Number of Populated Numeric Cells": populated,
            "Number of Fed Cells": fed,
          },
        },
      }),
      { mode: "runtime" },
    );
    expect(out.summary.byRule.cube_high_fed_ratio).toBe(severity ? 1 : 0);
    if (severity) {
      const f = out.findings.find(
        (x: { rule: string }) => x.rule === "cube_high_fed_ratio",
      );
      expect(f.severity).toBe(severity);
    }
    expect(out.runtimeStats.Ratio.fedToPopulatedRatio).toBe(
      populated === 0 ? null : fed / populated,
    );
  });

  it("reports feederMemoryRatio as secondary signal without flagging", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "MemRatio",
            rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
            skipCheck: true,
          },
        ],
        cubeStats: {
          MemRatio: {
            "Total Memory Used": 1_000_000,
            "Memory Used for Feeders": 800_000,
            "Memory Used for Input Data": 100_000,
            "Number of Populated Numeric Cells": 100,
            "Number of Fed Cells": 100,
          },
        },
      }),
      { mode: "runtime" },
    );
    expect(out.runtimeStats.MemRatio.feederMemoryRatio).toBe(8);
    expect(out.invalidCount).toBe(0);
  });

  it("runtime mode flags cube_high_memory above threshold", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "Heavy",
            rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
            skipCheck: true,
          },
        ],
        cubeStats: {
          Heavy: {
            "Total Memory Used": 2 * 1024 * 1024 * 1024, // 2 GiB
            "Number of Populated Numeric Cells": 100,
            "Number of Fed Cells": 100,
          },
        },
      }),
      { mode: "runtime" },
    );
    expect(out.summary.byRule.cube_high_memory).toBe(1);
    expect(out.runtimeStats.Heavy.memoryMb).toBeGreaterThan(1024);
  });

  it("mode both escalates static findings on cubes with runtime evidence", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "Wild",
            rulesText: [
              "skipcheck;",
              "['A','B'] = N: 1;",
              "feeders;",
              "[] => ['B'];",
            ].join("\n"),
            skipCheck: true,
          },
        ],
        cubeStats: {
          Wild: {
            "Total Memory Used": 1_000_000,
            "Number of Populated Numeric Cells": 1,
            "Number of Fed Cells": 1_000_000,
          },
        },
      }),
      { mode: "both" },
    );
    // Wildcard finding plus cube_high_fed_ratio (1M x). Both severity = evidence.
    const wildcard = out.findings.find(
      (f: { rule: string }) => f.rule === "wildcard_bracket",
    );
    expect(wildcard.severity).toBe("evidence");
    expect(out.summary.bySeverity.evidence).toBeGreaterThanOrEqual(2);
  });

  it("runtime mode degrades gracefully when }StatsByCube fetch fails", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "NoStats",
            rulesText: "skipcheck;\n['A']=N:1;\nfeeders;\n['A']=>['B'];",
            skipCheck: true,
          },
        ],
        // cubeStats intentionally omitted → executeMdx throws.
      }),
      { mode: "runtime" },
    );
    expect(out.scanned.runtimeFailures).toBe(1);
    expect(out.runtimeStats.NoStats.available).toBe(false);
    expect(out.summary.byRule.cube_high_fed_ratio).toBe(0);
    expect(out.summary.byRule.cube_high_memory).toBe(0);
  });

  it("uses positional element bag for orphan detection (real feeder style)", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "Posi",
            rulesText: [
              "skipcheck;",
              "['Wert','DS_000','Alpha'] = N: 1;",
              "feeders;",
              "['Alpha_Entry', 'Wert', 'DS_000'] => ['Alpha'];",
            ].join("\n"),
            skipCheck: true,
          },
        ],
      }),
    );
    expect(out.summary.byRule.orphan_feeder).toBe(0);
  });
});

// ── }StatsByCube unavailable (TM1 v12 has no }Stats* control cubes) ─────────
// The runtime half must say so once, keep the static half working, and never
// confuse "absent" with "denied". cube-stats-unavailable.test.ts owns the
// detection itself; these pin the tool-level report.
describe("tm1_audit_feeders when }StatsByCube is unavailable", () => {
  // v12's own wording — deliberately NOT the v11 sentence, to prove nothing
  // here depends on the prose. The verdict comes from `cubes.exists()`.
  const V12_ABSENT = new TM1Error({
    code: TM1ErrorCode.TM1_ERROR,
    message: 'There is no cube named "}StatsByCube".',
    httpStatus: 400,
    endpoint: "/api/v1/ExecuteMDX",
    details: 'There is no cube named "}StatsByCube".',
  });
  const DENIED = new TM1Error({
    code: TM1ErrorCode.PERMISSION_DENIED,
    message: "ObjectSecurityNoReadRights",
    httpStatus: 400,
    endpoint: "/api/v1/ExecuteMDX",
    details: "ObjectSecurityNoReadRights",
  });

  const RULES = [
    {
      cubeName: "Wide",
      rulesText: [
        "skipcheck;",
        "['A'] = N: 1;",
        "feeders;",
        "['A'] => ['B'];",
      ].join("\n"),
      skipCheck: true,
    },
    {
      cubeName: "Wild",
      rulesText: [
        "skipcheck;",
        "['A','B'] = N: 1;",
        "feeders;",
        "[] => ['B'];",
      ].join("\n"),
      skipCheck: true,
    },
  ];

  it("mode=runtime says runtime evidence is absent rather than failing", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "12.5.9",
        version: 12,
        rules: RULES,
        statsFailure: V12_ABSENT,
        statsCubeExists: false,
      }),
      { mode: "runtime" },
    );
    expect(out.runtimeUnavailable).toBeTruthy();
    expect(out.runtimeUnavailable.reason).toBe("absent");
    expect(out.runtimeUnavailable.cubes).toBe(2);
    expect(out.runtimeUnavailable.message).toMatch(/v12|Planning Analytics/i);
    expect(out.runtimeUnavailable.message).not.toMatch(/collection of type/i);
    // The identical per-cube message is not repeated N times.
    expect(out.runtimeStats).toEqual({});
    expect(out.scanned.runtimeAvailable).toBe(0);
  });

  it("a security denial reads as a denial, not as a missing feature", async () => {
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        version: 11,
        rules: RULES,
        statsFailure: DENIED,
      }),
      { mode: "runtime" },
    );
    expect(out.runtimeUnavailable.reason).toBe("denied");
    expect(out.runtimeUnavailable.message).toMatch(/permission|rights/i);
    expect(out.runtimeUnavailable.message).not.toMatch(/v12/);
  });
});

describe("tm1_audit_feeders dimension resolution", () => {
  const TWO_CUBES = [
    {
      cubeName: "Sales",
      rulesText: [
        "skipcheck;",
        "['A','B','C','D','E'] = N: 1;",
        "feeders;",
        "['A','B'] => ['E'];",
      ].join("\n"),
      skipCheck: true,
    },
    {
      cubeName: "Costs",
      rulesText: [
        "skipcheck;",
        "['A','B','C','D','E'] = N: 1;",
        "feeders;",
        "['A','B'] => ['E'];",
      ].join("\n"),
      skipCheck: true,
    },
  ];
  const DIMS = {
    Sales: ["D1", "D2", "D3", "D4", "D5"],
    Costs: ["D1", "D2", "D3", "D4", "D5"],
  };

  it("takes dimension names off the bulk rules request, not one call per cube", async () => {
    const dimCallLog: string[] = [];
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        dims: DIMS,
        dimCallLog,
        rules: TWO_CUBES,
      }),
    );

    expect(dimCallLog).toEqual([]);
    expect(out.scanned.dimResolveFailures).toBe(0);
    // Same verdict as the per-cube path produced: ratio scoring saw 5 dims.
    expect(out.summary.byRule.feeder_broader_than_rule).toBe(2);
    expect(out.findings[0].detail).toBe("pins 2 vs rule 5");
  });

  it("falls back to per-cube lookup when the server answers without the expansion", async () => {
    const dimCallLog: string[] = [];
    const out = await audit(
      makeAuditFeedersClientStub({
        productVersion: "11.8",
        dims: DIMS,
        dimCallLog,
        expandOmitsDimensions: true,
        rules: TWO_CUBES,
      }),
    );

    expect(dimCallLog).toEqual(["Sales", "Costs"]);
    expect(out.scanned.dimResolveFailures).toBe(0);
    expect(out.summary.byRule.feeder_broader_than_rule).toBe(2);
    expect(out.findings[0].detail).toBe("pins 2 vs rule 5");
  });
});
