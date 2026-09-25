// TM1 compiles variable names containing `.`, `$`, `%` and backtick
// (measured on 11.8 and 12.5, 2026-09-25). The parser and the analyzers used
// `[A-Za-z_]\w*`, so such an assignment failed the parse and every analysis
// of that tab went silent.
import { describe, it, expect } from "vitest";
import { parseTiCode } from "../../src/lib/callgraph/tiParser.js";
import { lintProcess } from "../../src/lib/complexity/antipatterns.js";

const EMPTY = { prolog: "", metadata: "", data: "", epilog: "" };
const rules = (code: Partial<Parameters<typeof lintProcess>[1]>) =>
  lintProcess("p", { ...EMPTY, ...code }).map((f) => f.rule);

describe("TI variable names TM1 accepts", () => {
  it.each(["v.Col", "v$Col", "v%Col", "v`Col", "v_Col"])(
    "%s parses and keeps the tab analysable",
    (name) => {
      const src = `${name} = 1;\nWHILE(1=1);\nExecuteProcess('Sub');\nEND;`;
      expect(parseTiCode(src).ok).toBe(true);
      expect(rules({ prolog: src })).toContain("exec-in-loop");
    },
  );

  it("counts a read of a dotted variable as a read", () => {
    expect(
      rules({ metadata: "v.Col = 1;", epilog: "nY = v.Col + 1;" }),
    ).not.toContain("dead-assignment");
  });
});
