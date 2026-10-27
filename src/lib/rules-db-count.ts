// Element-count check for DB() in cube rules: the one argument mistake
// tm1.CheckRules lets through. It rejects a wrong argument count on
// fixed-arity functions (ATTRN, SUBST, ElementAttrN, ...), but DB() takes a
// cube's worth of elements and CheckRules never compares that with the cube
// (verified on 11.8.03500: DB('Cube', !A, !B) on a three-dimension cube
// passes). The rule then reads 0 with no error anywhere (same build), so the
// mistake shows only as a wrong number. Rules address a cube without its
// Sandboxes dimension, the same as TI cell calls, so that dimension is not
// counted.
//
// Only DB() calls whose cube is a string literal naming an existing cube are
// checked. A computed cube name, or a cube that does not exist, is left to
// CheckRules and the run.
import { TM1Error, TM1ErrorCode } from "../types.js";
import { callArgs, quotedLiteral } from "./process-refs.js";

export interface DbCountIssue {
  lineNumber: number;
  cube: string;
  expected: number;
  got: number;
  message: string;
}

const SANDBOX_DIMENSION = "sandboxes";

// Blank everything from a '#' outside a string to the end of its line, keeping
// offsets, so DB( inside a comment is not found and line numbers still hold.
function maskComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'") inStr = !inStr;
        else if (ch === "#" && !inStr)
          return line.slice(0, i) + " ".repeat(line.length - i);
      }
      return line;
    })
    .join("\n");
}

export async function checkDbElementCounts(
  cubes: { getDimensionNames: (cube: string) => Promise<string[]> },
  rulesText: string,
): Promise<DbCountIssue[]> {
  const text = maskComments(rulesText.replace(/\r\n/g, "\n"));
  const calls: Array<{ cube: string; got: number; line: number }> = [];
  const re = /\bDB\s*\(/gi;
  let inStr = false;
  let scanned = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Skip a DB( inside a string literal: count quotes up to the match.
    for (; scanned < m.index; scanned++)
      if (text[scanned] === "'") inStr = !inStr;
    if (inStr) continue;
    const args = callArgs(text, m.index + m[0].length - 1);
    if (args === null || args.length === 0) continue;
    const cube = quotedLiteral(args[0]!);
    if (cube === null) continue;
    calls.push({
      cube,
      got: args.length - 1,
      line: text.slice(0, m.index).split("\n").length,
    });
  }

  const dimsOf = new Map<string, number | null>();
  for (const cube of new Set(calls.map((c) => c.cube))) {
    try {
      const dims = await cubes.getDimensionNames(cube);
      dimsOf.set(
        cube,
        dims.filter((d) => d.toLowerCase() !== SANDBOX_DIMENSION).length,
      );
    } catch (e) {
      if (e instanceof TM1Error && e.code === TM1ErrorCode.NOT_FOUND)
        dimsOf.set(cube, null);
      else throw e;
    }
  }

  const issues: DbCountIssue[] = [];
  for (const c of calls) {
    const expected = dimsOf.get(c.cube);
    if (expected == null || expected === c.got) continue;
    issues.push({
      lineNumber: c.line,
      cube: c.cube,
      expected,
      got: c.got,
      message: `DB('${c.cube}', ...) passes ${c.got} element(s), the cube takes ${expected} (Sandboxes not counted). CheckRules accepts this, and the rule then reads 0 without an error.`,
    });
  }
  return issues;
}
