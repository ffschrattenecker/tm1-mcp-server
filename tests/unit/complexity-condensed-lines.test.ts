import { describe, it, expect } from "vitest";
import { computeTabMetrics } from "../../src/lib/complexity/process-metrics.js";
import {
  lintProcess,
  type Finding,
} from "../../src/lib/complexity/antipatterns.js";
import type { ProcessCodeInput } from "../../src/lib/complexity/process-metrics.js";

/** Build a ProcessCodeInput with only the metadata tab set. */
function metadata(src: string): ProcessCodeInput {
  return { prolog: "", metadata: src, data: "", epilog: "" };
}

function deadAssignments(findings: Finding[]): Array<[string, number]> {
  return findings
    .filter((f) => f.rule === "dead-assignment")
    .map((f) => [f.snippet.replace(/ = \.\.\.$/, ""), f.line]);
}

// Bedrock-style code packs several statements onto one line. Metrics and lint
// must both read such a tab the same way.
describe("condensed lines: metrics", () => {
  const sample = [
    "IF(x=1); a=1; ELSEIF(y=2); a=2; ELSE; a=3; ENDIF;",
    "IF(a=1 & b=2); WHILE(i<3); i=i+1; END; ENDIF;",
    "b=1; c=2;",
  ].join("\n");

  it("counts branches, nesting and cost the same as the expanded form", () => {
    const m = computeTabMetrics(sample);
    expect(m.parseError).toBe(false);
    expect(m.loc).toBe(3);
    expect(m.branches).toBe(4);
    expect(m.maxNesting).toBe(2);
    expect(m.loopCost).toBe(2);
    expect(m.ifCost).toBe(4);
    expect(m.hotInLoop).toBe(0);
  });

  it("reads a condensed tab as the same metrics as its expanded form", () => {
    const expanded = [
      "IF(x=1);",
      "  a=1;",
      "ELSEIF(y=2);",
      "  a=2;",
      "ELSE;",
      "  a=3;",
      "ENDIF;",
      "IF(a=1 & b=2);",
      "  WHILE(i<3);",
      "    i=i+1;",
      "  END;",
      "ENDIF;",
      "b=1;",
      "c=2;",
    ].join("\n");
    const condensed = computeTabMetrics(sample);
    const plain = computeTabMetrics(expanded);
    expect(condensed.branches).toBe(plain.branches);
    expect(condensed.maxNesting).toBe(plain.maxNesting);
    expect(condensed.loopCost).toBe(plain.loopCost);
    expect(condensed.ifCost).toBe(plain.ifCost);
    expect(condensed.hotInLoop).toBe(plain.hotInLoop);
  });
});

describe("condensed lines: lint", () => {
  it("sees every assignment on a line with several statements", () => {
    const findings = lintProcess("Load_X", metadata("a=1; b=2;"));
    expect(deadAssignments(findings)).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("lints an IF/ELSE condensed onto one line", () => {
    const findings = lintProcess(
      "Load_X",
      metadata("IF(x=1); v=1; ELSE; v=2; ENDIF;"),
    );
    expect(deadAssignments(findings)).toEqual([["v", 1]]);
  });

  it("keeps the original line number for statements after a condensed line", () => {
    const findings = lintProcess(
      "Load_X",
      metadata("z=0;\nIF(a=1); v=1; ENDIF; w=2;"),
    );
    expect(deadAssignments(findings)).toEqual([
      ["z", 1],
      ["v", 2],
      ["w", 2],
    ]);
  });
});
