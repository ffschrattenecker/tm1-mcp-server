import { describe, it, expect } from "vitest";
import {
  lintReport,
  type Finding,
} from "../../src/lib/complexity/antipatterns.js";
import type { ProcessCodeInput } from "../../src/lib/complexity/process-metrics.js";

function code(parts: Partial<ProcessCodeInput>): ProcessCodeInput {
  return { prolog: "", metadata: "", data: "", epilog: "", ...parts };
}

function hits(parts: Partial<ProcessCodeInput>, rule: string): Finding[] {
  return lintReport("p", code(parts)).findings.filter((f) => f.rule === rule);
}

describe("section-placement", () => {
  it("errors on a documented restriction", () => {
    const [f] = hits(
      { data: `DimensionElementInsert('Dim', '', vEl, 'N');` },
      "section-placement",
    );
    expect(f?.severity).toBe("error");
    expect(f?.tab).toBe("data");
    expect(f?.hint).toMatch(/Direct/);
  });

  it("accepts the same call where it is allowed, and the Direct variant anywhere", () => {
    expect(
      hits(
        {
          metadata: `DimensionElementInsert('Dim', '', vEl, 'N');`,
          data: `DimensionElementInsertDirect('Dim', '', vEl, 'N');`,
        },
        "section-placement",
      ),
    ).toEqual([]);
  });

  it("errors on ItemSkip outside Metadata/Data", () => {
    expect(hits({ prolog: `ItemSkip;` }, "section-placement")).toHaveLength(1);
    expect(hits({ data: `ItemSkip;` }, "section-placement")).toEqual([]);
  });

  it("warns on a once-per-process call in Data, but not under an If", () => {
    const [f] = hits({ data: `CubeClearData('Sales');` }, "section-placement");
    expect(f?.severity).toBe("warn");
    expect(
      hits(
        { data: `IF(nFirst = 1);\n  CubeClearData('Sales');\nENDIF;` },
        "section-placement",
      ),
    ).toEqual([]);
  });

  it("reports the source line of a multi-statement line", () => {
    const [f] = hits(
      { prolog: `nX = 1;\nnY = 2; DisableBulkLoadMode();` },
      "section-placement",
    );
    expect(f?.line).toBe(2);
  });
});

describe("unreachable-code", () => {
  it("flags the first statement after ProcessQuit in the same block", () => {
    const [f] = hits(
      { prolog: `ProcessQuit;\nnX = 1;\nnY = 2;` },
      "unreachable-code",
    );
    expect(f?.line).toBe(2);
  });

  it("does not flag a terminator that ends its block", () => {
    expect(
      hits(
        { data: `IF(vX @= '');\n  ItemSkip;\nENDIF;\nnY = 2;` },
        "unreachable-code",
      ),
    ).toEqual([]);
  });

  it("flags inside a nested block", () => {
    expect(
      hits(
        { data: `IF(vX @= '');\n  ItemReject('empty');\n  nY = 2;\nENDIF;` },
        "unreachable-code",
      ),
    ).toHaveLength(1);
  });
});

describe("datasource-after-prolog", () => {
  it("warns on a datasource assignment after the Prolog", () => {
    const [f] = hits(
      { metadata: `DatasourceNameForServer = 'x.csv';` },
      "datasource-after-prolog",
    );
    expect(f?.severity).toBe("warn");
  });

  it("masks a credential in the snippet", () => {
    const [f] = hits(
      { data: `DatasourcePassword = 'hunter2';` },
      "datasource-after-prolog",
    );
    expect(f?.snippet).not.toContain("hunter2");
  });

  it("accepts the ASCII format variables later: they also shape TextOutput", () => {
    expect(
      hits(
        { epilog: `DatasourceAsciiQuoteCharacter = '';\nTextOutput(sFile, sRow);` },
        "datasource-after-prolog",
      ),
    ).toEqual([]);
  });

  it("accepts it in the Prolog", () => {
    expect(
      hits(
        { prolog: `DatasourceType = 'CHARACTERDELIMITED';` },
        "datasource-after-prolog",
      ),
    ).toEqual([]);
  });
});

describe("hardcoded-credential", () => {
  it("flags a literal ODBC password and masks it in the snippet", () => {
    const [f] = hits(
      { prolog: `ODBCOpen('DSN', 'sa', 'hunter2');` },
      "hardcoded-credential",
    );
    expect(f).toBeDefined();
    expect(f?.snippet).not.toContain("hunter2");
  });

  it("accepts a password from a parameter", () => {
    expect(
      hits({ prolog: `ODBCOpen('DSN', 'sa', pPassword);` }, "hardcoded-credential"),
    ).toEqual([]);
  });

  it("flags a secret-named variable set from a literal, not from a call", () => {
    expect(
      hits({ prolog: `sPassword = 'hunter2';` }, "hardcoded-credential"),
    ).toHaveLength(1);
    expect(
      hits(
        { prolog: `sPassword = CellGetS('Cfg', 'pwd', 'Value');` },
        "hardcoded-credential",
      ),
    ).toEqual([]);
  });
});

describe("trailing-comment", () => {
  it("errors on a # after code", () => {
    const [f] = hits({ prolog: `nX = 1;\nnY = 2; # note` }, "trailing-comment");
    expect(f?.severity).toBe("error");
    expect(f?.line).toBe(2);
  });

  it("ignores comment lines and # inside strings", () => {
    expect(
      hits(
        { prolog: `# a comment\n  # indented\nsD = '#';\nsE = 'it''s #1';` },
        "trailing-comment",
      ),
    ).toEqual([]);
  });

  it("still reports on a tab the parser rejects", () => {
    const r = lintReport("p", code({ prolog: `IF(x = 1; # broken` }));
    expect(r.findings.map((f) => f.rule)).toContain("trailing-comment");
  });
});

describe("lintCode (tm1_check_process_code)", () => {
  it("drops dead-assignment on a fragment: the read may be in an omitted tab", async () => {
    const { lintCode } = await import(
      "../../src/tools/ti-development/preflight.js"
    );
    const tabs = { metadata: `nUnused = 1;` };
    const rules = (partial: boolean) =>
      lintCode("p", tabs, partial).findings.map((f) => f.rule);
    expect(rules(false)).toContain("dead-assignment");
    expect(rules(true)).not.toContain("dead-assignment");
  });
});
