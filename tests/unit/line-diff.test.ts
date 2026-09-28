import { describe, expect, it } from "vitest";
import { MAX_DIFF_CELLS, tabCodeDiff } from "../../src/lib/line-diff.js";

describe("tabCodeDiff", () => {
  it("reports identical text across CRLF and trailing whitespace", () => {
    const r = tabCodeDiff("a\r\nb\r\n", "a\nb", 3);
    expect(r).toEqual({ identical: true, linesA: 2, linesB: 2, hunks: [] });
  });

  it("finds a one-character change in a long text with correct line numbers", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `['L${i}'] = N: 1;`);
    const changed = [...base];
    changed[2500] = "['L2500'] = N: 2;";
    const r = tabCodeDiff(base.join("\n"), changed.join("\n"), 1);
    expect(r.identical).toBe(false);
    expect(r.hunks).toHaveLength(1);
    const h = r.hunks[0];
    expect(h.startA).toBe(2500);
    expect(h.startB).toBe(2500);
    expect(h.lines).toEqual([
      { type: " ", text: "['L2499'] = N: 1;" },
      { type: "-", text: "['L2500'] = N: 1;" },
      { type: "+", text: "['L2500'] = N: 2;" },
      { type: " ", text: "['L2501'] = N: 1;" },
    ]);
  });

  it("handles insertions at the head and tail", () => {
    const r = tabCodeDiff("b\nc", "a\nb\nc\nd", 0);
    expect(r.hunks.map((h) => h.lines)).toEqual([
      [{ type: "+", text: "a" }],
      [{ type: "+", text: "d" }],
    ]);
  });

  it("gives up with tooLarge when the changed region exceeds the cap", () => {
    const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join("\n");
    const r = tabCodeDiff(a, b, 3);
    expect(r).toEqual({
      identical: false,
      linesA: n,
      linesB: n,
      hunks: [],
      tooLarge: true,
    });
  });
});
