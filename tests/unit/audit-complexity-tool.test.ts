import { describe, it, expect } from "vitest";
import { registerAuditComplexity } from "../../src/tools/analysis/audit-complexity.js";
import { captureParsedTool } from "../helpers/client-harness.js";

interface FakeProcess {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
}

/** A process whose only code is `prolog`. */
function proc(name: string, prolog = ""): FakeProcess {
  return { name, prolog, metadata: "", data: "", epilog: "" };
}

interface FakeArgs {
  productVersion: string;
  processes?: FakeProcess[];
  variables?: Record<
    string,
    Array<{ name: string; type: "String" | "Numeric"; position: number }>
  >;
  rules?: Array<{ cubeName: string; rulesText: string; skipCheck: boolean }>;
  /** Overrides the bulk lookup so a test can instrument ordering/failures. */
  getAllVariablesImpl?: (
    includeControl: boolean,
  ) => Promise<
    Map<
      string,
      Array<{ name: string; type: "String" | "Numeric"; position: number }>
    >
  >;
}

function makeAuditComplexityClientStub(args: FakeArgs) {
  // Mirrors the real services, which apply $filter=not startswith(Name,'}')
  // server-side when includeControl=false.
  const isControl = (n: string) => n.startsWith("}");
  return {
    server: { getInfo: async () => ({ productVersion: args.productVersion }) },
    processes: {
      getAllCode: async (includeControl = false) => {
        const all = args.processes ?? [];
        return includeControl ? all : all.filter((p) => !isControl(p.name));
      },
      getAllVariables: async (includeControl = false) => {
        if (args.getAllVariablesImpl)
          return await args.getAllVariablesImpl(includeControl);
        const names = (args.processes ?? [])
          .map((p) => p.name)
          .filter((n) => includeControl || !isControl(n));
        return new Map(names.map((n) => [n, args.variables?.[n] ?? []]));
      },
    },
    cubes: {
      getAllRules: async (includeControl = false) => {
        const all = args.rules ?? [];
        return includeControl ? all : all.filter((r) => !isControl(r.cubeName));
      },
    },
  } as unknown as Parameters<typeof registerAuditComplexity>[1];
}

/** Run tm1_audit_complexity against a stub and parse its JSON result. */
async function audit(
  tm1: Parameters<typeof registerAuditComplexity>[1],
  args: Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const call = captureParsedTool(registerAuditComplexity, tm1);
  const raw = (await call(args)) as { content: Array<{ text: string }> };
  return JSON.parse(raw.content[0].text);
}

describe("tm1_audit_complexity tool", () => {
  it("returns pass when no objects exist", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({ productVersion: "11.8" }),
    );
    expect(out.status).toBe("pass");
    expect(out.scanned.processes).toBe(0);
    expect(out.scanned.rules).toBe(0);
  });

  it("scans processes and reports topProcesses sorted by score", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [
          proc("Trivial", "x=1;"),
          proc("Complex", "IF(a=1);\n  WHILE(b<10);\n    c=1;\n  END;\nENDIF;"),
        ],
      }),
      { scope: ["processes"] },
    );
    expect(out.scanned.processes).toBe(2);
    expect(out.topProcesses[0].name).toBe("Complex");
    expect(out.topProcesses[0].totals.maxNesting).toBe(2);
  });

  it("excludes control objects by default", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("}Stats_Process", "x=1;"), proc("Real", "y=2;")],
      }),
      { scope: ["processes"] },
    );
    expect(out.scanned.processes).toBe(1);
    expect(out.topProcesses[0].name).toBe("Real");
  });

  it("scans rules and lists cubes without skipcheck", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        rules: [
          {
            cubeName: "WithCheck",
            rulesText: "skipcheck;\n['A']=N:1;",
            skipCheck: true,
          },
          { cubeName: "NoCheck", rulesText: "['A']=N:1;", skipCheck: false },
        ],
      }),
      { scope: ["rules"] },
    );
    expect(out.scanned.rules).toBe(2);
    expect(out.summary.rules.cubesWithoutSkipcheck).toEqual(["NoCheck"]);
  });

  it("respects topN cap", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: Array.from({ length: 30 }, (_, i) =>
          proc(`P${i}`, `x=${i};`),
        ),
      }),
      { scope: ["processes"], topN: 5 },
    );
    expect(out.scanned.processes).toBe(30);
    expect(out.topProcesses).toHaveLength(5);
    expect(out.truncated.processes).toBe(true);
  });

  it("status=pass when only trivial processes exist and no consistency issues", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("Tiny", "x=1;")],
      }),
      { scope: ["processes"] },
    );
    expect(out.scanned.processes).toBe(1);
    expect(out.topProcesses).toHaveLength(1);
    expect(out.status).toBe("pass");
  });

  it("status=fail when scoreThreshold>0 is met by topProcesses", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [
          proc("Big", "IF(a=1);\n  IF(b=1);\n    c=1;\n  ENDIF;\nENDIF;"),
        ],
      }),
      { scope: ["processes"], scoreThreshold: 5 },
    );
    expect(out.topProcesses.length).toBeGreaterThan(0);
    expect(out.status).toBe("fail");
  });

  // FlatBig: 10 sibling IFs (branch-heavy, no loops) -> high v1, modest v2.
  // DeepLoop: 4 nested whiles -> modest v1, high v2 (loop nesting multiplies).
  const FLAT_BIG = Array.from(
    { length: 10 },
    () => "IF(x=1);\na=1;\nENDIF;",
  ).join("\n");
  const DEEP_LOOP =
    "WHILE(a<1);\nWHILE(b<1);\nWHILE(c<1);\nWHILE(d<1);\nx=1;\nEND;\nEND;\nEND;\nEND;";

  it("ranks by v1 score by default (branch-heavy process first)", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("DeepLoop", DEEP_LOOP), proc("FlatBig", FLAT_BIG)],
      }),
      { scope: ["processes"] },
    );
    expect(out.topProcesses[0].name).toBe("FlatBig");
  });

  it("ranks by v2 score when rankBy=scoreV2 (loop-nesting process first)", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("FlatBig", FLAT_BIG), proc("DeepLoop", DEEP_LOOP)],
      }),
      { scope: ["processes"], rankBy: "scoreV2" },
    );
    expect(out.topProcesses[0].name).toBe("DeepLoop");
    expect(out.topProcesses[0].totals.scoreV2).toBeGreaterThan(
      out.topProcesses[1].totals.scoreV2,
    );
  });

  it("scoreThreshold filters low-score entries", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [
          proc("Tiny", "x=1;"),
          proc("Big", "IF(a=1);\n  IF(b=1);\n    c=1;\n  ENDIF;\nENDIF;"),
        ],
      }),
      { scope: ["processes"], scoreThreshold: 10 },
    );
    expect(
      out.topProcesses.every(
        (p: { totals: { score: number } }) => p.totals.score >= 10,
      ),
    ).toBe(true);
  });

  it("scope=antipatterns reports findings and fails on an error-severity rule", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("Daily_Load", "CubeClearData('Sales');")],
      }),
      { scope: ["antipatterns"] },
    );
    expect(
      out.antipatterns.findings.map((f: { rule: string }) => f.rule),
    ).toContain("destructive-unguarded");
    expect(out.antipatterns.summary.error).toBe(1);
    expect(out.status).toBe("fail");
  });

  it("antipatterns is not scanned by default", async () => {
    const out = await audit(
      makeAuditComplexityClientStub({
        productVersion: "11.8",
        processes: [proc("Daily_Load", "CubeClearData('Sales');")],
      }),
    );
    expect(out.antipatterns).toBeNull();
    expect(out.status).toBe("pass");
  });

  describe("consistency variables", () => {
    it("treats a process missing from the response as having no variables", async () => {
      // Not a hypothetical: $select omits the complex property entirely for a
      // process that has none, so the map legitimately lacks that key. It must
      // read as "no variables" — the same answer the per-process call gave —
      // and never as a failure.
      const out = await audit(
        makeAuditComplexityClientStub({
          productVersion: "11.8",
          processes: [proc("Known"), proc("Absent")],
          getAllVariablesImpl: async () =>
            new Map([
              [
                "Known",
                [{ name: "pYear", type: "Numeric" as const, position: 1 }],
              ],
            ]),
        }),
        { scope: ["consistency"] },
      );
      // Prefix convention counts processes that HAVE variables, so the
      // omitted one contributes nothing — exactly as an empty array would.
      expect(out.consistency.prefixConvention.total).toBe(1);
    });

    it("keeps fail-fast: a failed request fails the tool call", async () => {
      // A cross-process aggregate built from a partial scan is quietly wrong,
      // which is worse than an error.
      const call = captureParsedTool(
        registerAuditComplexity,
        makeAuditComplexityClientStub({
          productVersion: "11.8",
          processes: [proc("P1"), proc("P2")],
          getAllVariablesImpl: async () => {
            throw new Error("TM1 rejected the variables query");
          },
        }),
      );
      await expect(call({ scope: ["consistency"] })).rejects.toThrow(
        "TM1 rejected the variables query",
      );
    });
  });
});
