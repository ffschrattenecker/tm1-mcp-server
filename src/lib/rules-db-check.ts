// DB() checks for cube rules: the mistakes in a DB() call that tm1.CheckRules
// lets through. CheckRules resolves the elements of a [...] reference ("Element
// not found"), but a DB() is only a call with string arguments to it
// (verified on 11.8.03500, in rules and in feeders alike):
//   - a cube that does not exist passes;
//   - a literal element that does not exist in its dimension passes;
//   - a wrong element count passes. DB() takes a cube's worth of elements and
//     CheckRules never compares that with the cube: DB('Cube', !A, !B) on a
//     three-dimension cube passes.
// In all three the stored rule then reads 0 with no error anywhere (same
// build), so the mistake shows only as a wrong number.
// Rules address a cube without its Sandboxes dimension, the same as TI cell
// calls, so that dimension is not counted and positions map onto the others.
//
// Only DB() calls whose cube is a string literal are checked, and of their
// elements only string literals: !Dim, ATTRS(...) and nested DB() are what the
// rule computes, and a computed cube name is left to the run. Elements are
// looked up with TM1's own name resolution (case/space-insensitive, aliases),
// so a name TM1 resolves is never reported.
import { TM1Error, TM1ErrorCode } from "../types.js";
import { mapSettledWithConcurrency } from "./concurrency.js";
import { callArgs, elementResolves, quotedLiteral } from "./process-refs.js";

export interface DbCheckIssue {
  lineNumber: number;
  cube: string;
  message: string;
}

export interface DbCheckLookups {
  cubes: { getDimensionNames: (cube: string) => Promise<string[]> };
  elements: {
    exists: (dim: string, hierarchy: string, el: string) => Promise<boolean>;
  };
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

interface DbCall {
  cube: string;
  elements: Array<string | null>; // null = not a string literal
  line: number;
}

function findDbCalls(rulesText: string): DbCall[] {
  const text = maskComments(rulesText.replace(/\r\n/g, "\n"));
  const calls: DbCall[] = [];
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
      elements: args.slice(1).map((a) => quotedLiteral(a)),
      line: text.slice(0, m.index).split("\n").length,
    });
  }
  return calls;
}

export async function checkDbReferences(
  lookups: DbCheckLookups,
  rulesText: string,
): Promise<DbCheckIssue[]> {
  const calls = findDbCalls(rulesText);

  // Dimensions of each named cube, Sandboxes dropped; null = no such cube.
  const dimsOf = new Map<string, string[] | null>();
  for (const cube of new Set(calls.map((c) => c.cube))) {
    try {
      const dims = await lookups.cubes.getDimensionNames(cube);
      dimsOf.set(
        cube,
        dims.filter((d) => d.toLowerCase() !== SANDBOX_DIMENSION),
      );
    } catch (e) {
      if (e instanceof TM1Error && e.code === TM1ErrorCode.NOT_FOUND)
        dimsOf.set(cube, null);
      else throw e;
    }
  }

  const issues: DbCheckIssue[] = [];
  // Distinct (dimension, element) pairs, every call that names them kept.
  const pending = new Map<
    string,
    { dim: string; el: string; calls: DbCall[] }
  >();
  for (const c of calls) {
    const dims = dimsOf.get(c.cube);
    if (dims === null) {
      issues.push({
        lineNumber: c.line,
        cube: c.cube,
        message: `DB('${c.cube}', ...) names a cube that does not exist.`,
      });
      continue;
    }
    if (dims === undefined) continue;
    if (dims.length !== c.elements.length) {
      issues.push({
        lineNumber: c.line,
        cube: c.cube,
        message: `DB('${c.cube}', ...) passes ${c.elements.length} element(s), the cube takes ${dims.length} (Sandboxes not counted).`,
      });
      continue;
    }
    c.elements.forEach((el, i) => {
      // An empty name is not a lookup TM1 answers with yes or no.
      if (el === null || el === "") return;
      const dim = dims[i]!;
      const key = `${dim.toLowerCase()}\u0000${el.toLowerCase()}`;
      const entry = pending.get(key) ?? { dim, el, calls: [] };
      entry.calls.push(c);
      pending.set(key, entry);
    });
  }

  const todo = [...pending.values()];
  const settled = await mapSettledWithConcurrency(todo, 8, ({ dim, el }) =>
    elementResolves(lookups.elements, dim, el),
  );
  todo.forEach(({ dim, el, calls: named }, i) => {
    const r = settled[i]!;
    // A lookup that failed for any reason other than "not found" (auth,
    // transport, denial) must surface, not read as a missing element.
    if (r.status === "rejected") throw r.reason;
    if (r.value) return;
    for (const c of named)
      issues.push({
        lineNumber: c.line,
        cube: c.cube,
        message: `DB('${c.cube}', ...) names element '${el}', which is not in dimension '${dim}'.`,
      });
  });
  return issues.sort((a, b) => a.lineNumber - b.lineNumber);
}
