/**
 * Line diff shared by the process, rule and hierarchy diff tools: an LCS edit
 * script rendered as unified-style hunks.
 */

type EditOp = { op: "eq" | "add" | "del"; line: string };

function computeEditScript(a: string[], b: string[]): EditOp[] {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * w + j] = 1 + (dp[(i + 1) * w + (j + 1)] ?? 0);
      } else {
        const skipA = dp[(i + 1) * w + j] ?? 0;
        const skipB = dp[i * w + (j + 1)] ?? 0;
        dp[i * w + j] = skipA >= skipB ? skipA : skipB;
      }
    }
  }

  const ops: EditOp[] = [];
  let i = 0,
    j = 0;
  while (i < m || j < n) {
    const ai = a[i],
      bj = b[j];
    if (i < m && j < n && ai === bj) {
      ops.push({ op: "eq", line: ai! });
      i++;
      j++;
    } else if (
      i < m &&
      (j >= n || (dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + (j + 1)] ?? 0))
    ) {
      ops.push({ op: "del", line: ai! });
      i++;
    } else {
      ops.push({ op: "add", line: bj! });
      j++;
    }
  }
  return ops;
}

export interface DiffHunk {
  startA: number;
  countA: number;
  startB: number;
  countB: number;
  lines: Array<{ type: " " | "+" | "-"; text: string }>;
}

function buildHunks(ops: EditOp[], contextLines: number): DiffHunk[] {
  type Positioned = {
    op: "eq" | "add" | "del";
    line: string;
    lineA: number;
    lineB: number;
  };
  const pos: Positioned[] = [];
  let lA = 1,
    lB = 1;
  for (const op of ops) {
    pos.push({ ...op, lineA: lA, lineB: lB });
    if (op.op === "eq") {
      lA++;
      lB++;
    } else if (op.op === "del") {
      lA++;
    } else {
      lB++;
    }
  }

  const inHunk = new Set<number>();
  for (let i = 0; i < pos.length; i++) {
    if (pos[i]!.op !== "eq") {
      for (
        let k = Math.max(0, i - contextLines);
        k <= Math.min(pos.length - 1, i + contextLines);
        k++
      ) {
        inHunk.add(k);
      }
    }
  }
  if (inHunk.size === 0) return [];

  const indices = [...inHunk].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  let s = indices[0]!,
    p = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! > p + 1) {
      ranges.push([s, p]);
      s = indices[i]!;
    }
    p = indices[i]!;
  }
  ranges.push([s, p]);

  return ranges.map(([from, to]) => {
    const lines: DiffHunk["lines"] = [];
    let startA = -1,
      startB = -1,
      countA = 0,
      countB = 0;
    for (let i = from; i <= to; i++) {
      const px = pos[i]!;
      if (startA === -1) {
        startA = px.lineA;
        startB = px.lineB;
      }
      if (px.op === "eq") {
        lines.push({ type: " ", text: px.line });
        countA++;
        countB++;
      } else if (px.op === "del") {
        lines.push({ type: "-", text: px.line });
        countA++;
      } else {
        lines.push({ type: "+", text: px.line });
        countB++;
      }
    }
    return { startA, countA, startB, countB, lines };
  });
}

const NORM = (s: string): string => s.replace(/\r\n/g, "\n").trimEnd();

/**
 * Largest LCS table (cells) the diff will build: the table is a Uint32Array of
 * (m+1)·(n+1) over the lines left once the common head and tail are trimmed,
 * so this bounds it at 64 MB. Beyond it the diff reports only line counts.
 */
export const MAX_DIFF_CELLS = 16_000_000;

export interface TextDiff {
  identical: boolean;
  linesA: number;
  linesB: number;
  hunks: DiffHunk[];
  /** Set when the changed region was too large to diff; hunks is empty. */
  tooLarge?: true;
}

export function tabCodeDiff(
  codeA: string,
  codeB: string,
  contextLines: number,
): TextDiff {
  const na = NORM(codeA);
  const nb = NORM(codeB);
  if (na === nb) {
    const lc = na ? na.split("\n").length : 0;
    return { identical: true, linesA: lc, linesB: lc, hunks: [] };
  }
  const a = na ? na.split("\n") : [];
  const b = nb ? nb.split("\n") : [];
  // Diff only the region between the common head and tail: an edit to a long
  // text then costs a table the size of the edit, not of the whole text.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) {
    return {
      identical: false,
      linesA: a.length,
      linesB: b.length,
      hunks: [],
      tooLarge: true,
    };
  }
  const eq = (line: string): EditOp => ({ op: "eq", line });
  const ops = [
    ...a.slice(0, head).map(eq),
    ...computeEditScript(midA, midB),
    ...a.slice(a.length - tail).map(eq),
  ];
  const hunks = buildHunks(ops, contextLines);
  return { identical: false, linesA: a.length, linesB: b.length, hunks };
}
