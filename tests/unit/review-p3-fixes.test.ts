// P3 findings from the 2026-09-22 review, each measured live on 11.8 and 12.5
// before the fix.
import { describe, it, expect } from "vitest";
import { computeTabMetrics } from "../../src/lib/complexity/process-metrics.js";
import { V12_DEPRECATED_TI } from "../../src/lib/v12-compat/deprecated-ti.js";
import { scanForDeprecatedTi } from "../../src/lib/v12-compat/scanner.js";

describe("TI parser: `;;` inside a string literal", () => {
  it("is not a syntax error; TM1 compiles it", () => {
    const m = computeTabMetrics("sQ = 'SELECT a FROM t WHERE b=1;;';\nnI = 1;");
    expect(m.parseError).toBe(false);
    expect(m.loc).toBeGreaterThan(0);
  });

  it("outside a literal still is", () => {
    expect(computeTabMetrics("nI = 1;;").parseError).toBe(true);
  });
});

describe("v12 readiness: ODBC", () => {
  it("flags SetODBCUnicodeInterface without claiming ODBC is gone", () => {
    const e =
      V12_DEPRECATED_TI.get("setodbcunicodeinterface") ??
      [...V12_DEPRECATED_TI.values()].find(
        (x) => x.name === "SetOdbcUnicodeInterface",
      );
    expect(e?.issue).not.toMatch(/data sources removed/i);
  });

  it("does not flag the ODBC functions v12 still compiles", () => {
    const hits = scanForDeprecatedTi(
      "ODBCOpen('X','u','p');\nODBCOutput('X','q');\nODBCClose('X');",
    );
    expect(hits).toEqual([]);
  });
});
