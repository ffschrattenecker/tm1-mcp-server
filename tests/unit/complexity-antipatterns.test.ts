import { describe, it, expect } from "vitest";
import {
  lintProcess,
  type Finding,
} from "../../src/lib/complexity/antipatterns.js";
import type { ProcessCodeInput } from "../../src/lib/complexity/process-metrics.js";

/** Build a ProcessCodeInput from partial tabs (unset tabs are empty). */
function code(parts: Partial<ProcessCodeInput>): ProcessCodeInput {
  return { prolog: "", metadata: "", data: "", epilog: "", ...parts };
}

function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

describe("destructive-unguarded", () => {
  it("flags an unconditional CubeClearData as an error", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `CubeClearData('Sales');` }),
    );
    const hit = findings.find((f) => f.rule === "destructive-unguarded");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
    expect(hit?.tab).toBe("prolog");
    expect(hit?.line).toBe(1);
  });

  it("does not flag a destructive op guarded by an enclosing If", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `IF(pMode=1);\n  CubeClearData('Sales');\nENDIF;` }),
    );
    expect(rules(findings)).not.toContain("destructive-unguarded");
  });

  it("downgrades to warn when the process name signals a clear/init/zeroout/test proc", () => {
    for (const name of [
      "ZeroOut_Cube",
      "FP_InitImport_TM1",
      "Cube_Clear_All",
      "zzz_Test_Reset",
    ]) {
      const findings = lintProcess(
        name,
        code({ prolog: `CubeClearData(vCube);` }),
      );
      const hit = findings.find((f) => f.rule === "destructive-unguarded");
      expect(hit, name).toBeDefined();
      expect(hit?.severity, name).toBe("warn");
    }
  });

  it("keeps error severity for a normally-named destructive proc", () => {
    const findings = lintProcess(
      "Sales_Import",
      code({ prolog: `CubeClearData(vCube);` }),
    );
    const hit = findings.find((f) => f.rule === "destructive-unguarded");
    expect(hit?.severity).toBe("error");
  });
});

describe("exec-in-loop", () => {
  it("flags ExecuteProcess inside a while as a sync-complexity warning", () => {
    const findings = lintProcess(
      "p",
      code({
        data: `WHILE(i<10);\n  ExecuteProcess('Child');\n  i=i+1;\nEND;`,
      }),
    );
    const hit = findings.find((f) => f.rule === "exec-in-loop");
    expect(hit?.severity).toBe("warn");
    expect(hit?.line).toBe(2);
    expect(hit?.hint.toLowerCase()).toContain("sync");
  });

  it("flags RunProcess inside a while with an async timing/persistence hint", () => {
    const findings = lintProcess(
      "p",
      code({ data: `WHILE(i<10);\n  RunProcess('Child');\n  i=i+1;\nEND;` }),
    );
    const hit = findings.find((f) => f.rule === "exec-in-loop");
    expect(hit?.severity).toBe("warn");
    expect(hit?.hint.toLowerCase()).toContain("async");
  });

  it("does not flag ExecuteProcess outside any loop", () => {
    const findings = lintProcess(
      "p",
      code({ prolog: `ExecuteProcess('Child');` }),
    );
    expect(rules(findings)).not.toContain("exec-in-loop");
  });
});

/** CellGetN against `cube` with `dims` element args. */
function cellGet(cube: string, dims: number): string {
  const elems = Array.from({ length: dims }, (_, i) => `e${i}`).join(", ");
  return `'${cube}', ${elems}`;
}

describe("cellget-perf", () => {
  it.each([
    {
      label: "flags a high-dimensional CellGetN standalone as info",
      data: `v = CellGetN(${cellGet("Big", 12)});`,
      threshold: undefined,
      severity: "info",
      line: 1,
    },
    {
      label: "escalates a high-dimensional CellGetN inside a loop to warn",
      data: `WHILE(i<10);\n  v = CellGetN(${cellGet("Big", 12)});\nEND;`,
      threshold: undefined,
      severity: "warn",
      line: 2,
    },
    {
      label: "honors a custom cellGetDimThreshold",
      data: `v = CellGetN(${cellGet("Mid", 5)});`,
      threshold: 5,
      severity: "info",
      line: 1,
    },
  ])("$label", ({ data, threshold, severity, line }) => {
    const findings = lintProcess(
      "p",
      code({ data }),
      threshold === undefined ? undefined : { cellGetDimThreshold: threshold },
    );
    const hit = findings.find((f) => f.rule === "cellget-perf");
    expect(hit?.severity).toBe(severity);
    expect(hit?.line).toBe(line);
  });

  it("does not flag a CellGetN below the dimension threshold", () => {
    const findings = lintProcess(
      "p",
      code({ data: `v = CellGetN(${cellGet("Small", 3)});` }),
    );
    expect(rules(findings)).not.toContain("cellget-perf");
  });
});

describe("dead-assignment", () => {
  it("flags a variable assigned in data tab but never read", () => {
    const findings = lintProcess(
      "p",
      code({ data: `vTemp = 42;\nNVALUE = 1;` }),
    );
    const hit = findings.find((f) => f.rule === "dead-assignment");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("info");
    expect(hit?.snippet).toContain("vTemp");
    expect(hit?.tab).toBe("data");
  });

  it("flags a variable assigned in metadata tab but never read", () => {
    const findings = lintProcess("p", code({ metadata: `vDead = 'unused';` }));
    const hit = findings.find((f) => f.rule === "dead-assignment");
    expect(hit?.tab).toBe("metadata");
  });

  it("reports dead variable only once even if assigned multiple times", () => {
    const findings = lintProcess("p", code({ data: `vX = 1;\nvX = 2;` }));
    const hits = findings.filter((f) => f.rule === "dead-assignment");
    expect(hits.length).toBe(1);
  });

  it.each([
    {
      label: "a variable read in the same tab",
      parts: { data: `vX = 5;\nNVALUE = vX * 2;` },
    },
    {
      label: "a data-tab variable read in epilog",
      parts: {
        data: `vSum = vSum + 1;`,
        epilog: `ASCIIOutput('out.txt', NumberToString(vSum));`,
      },
    },
    {
      label: "a prolog assignment (only data/metadata are flagged)",
      parts: { prolog: `vUnused = 99;` },
    },
    {
      label: "a metadata variable read in data",
      parts: {
        metadata: `vElem = 'Total';`,
        data: `IF(vElem @= 'Total');\n  NVALUE = 0;\nENDIF;`,
      },
    },
    {
      label: "the implicit TI vars NVALUE / SVALUE / VALUE_IS_STRING",
      parts: { data: `NVALUE = 0;\nSVALUE = '';\nVALUE_IS_STRING = 0;` },
    },
    {
      label: "V1..Vn datasource column vars",
      parts: { data: `V1 = V1;\nV12 = V12;` },
    },
    {
      label: "a side-effecting RHS (rc = ExecuteProcess)",
      parts: { data: `rc = ExecuteProcess('Child', 'p', 1);` },
    },
    {
      label: "Expand('%vPath%') as a read of vPath",
      parts: {
        data: `vPath = 'data';\nASCIIOutput(Expand('%vPath%\\out.txt'), SValue);`,
      },
    },
    {
      label: "a loop counter that appears in the WHILE condition",
      parts: { data: `i = 1;\nWHILE(i <= 10);\n  i = i + 1;\nEND;` },
    },
  ])("does not flag $label", ({ parts }) => {
    const findings = lintProcess("p", code(parts));
    expect(rules(findings)).not.toContain("dead-assignment");
  });
});

describe("hardcoded-path", () => {
  it.each([
    {
      label: "a hardcoded UNC path literal",
      prolog: `ASCIIOutput('\\\\srv\\share\\out.txt', n);`,
      flagged: true,
    },
    {
      label: "a hardcoded drive-letter path literal",
      prolog: `ASCIIOutput('C:\\temp\\out.txt', n);`,
      flagged: true,
    },
    {
      label: "a non-path string literal",
      prolog: `ASCIIOutput('out.txt', n);`,
      flagged: false,
    },
  ])("$label", ({ prolog, flagged }) => {
    const findings = lintProcess("p", code({ prolog }));
    if (!flagged) {
      expect(rules(findings)).not.toContain("hardcoded-path");
      return;
    }
    const hit = findings.find((f) => f.rule === "hardcoded-path");
    expect(hit?.severity).toBe("warn");
    expect(hit?.line).toBe(1);
  });
});
