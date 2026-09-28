// ─── String/comment neutralization ──────────────────────────────────────────

/** Replaces quoted strings with same-length spaces and strips trailing comments. */
function neutralizeLine(line: string): string {
  return line
    .replace(/'[^']*'/g, (s) => " ".repeat(s.length))
    .replace(/#.*$/, "");
}

// ─── Phase 1: Bracket extraction & syntax validation ────────────────────────

/**
 * Extracts all [...] block contents from a line (from original, not neutralized).
 * Uses neutralized positions to avoid false positives inside strings/comments.
 */
export function extractBracketRefs(line: string): string[] {
  const neutralized = neutralizeLine(line);
  const results: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < neutralized.length; i++) {
    const ch = neutralized[i];
    if (ch === "[") {
      if (depth === 0) {
        start = i + 1;
      }
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(line.slice(start, i).trim());
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Validates the syntax of a [...] cell reference content (without outer brackets).
 * Returns an error message or null if valid.
 *
 * Valid forms:
 *   'DimName':'ElemName'
 *   'DimName':{'E1','E2',...}
 *   Multiple of the above separated by commas
 */
export function validateBracketRefSyntax(content: string): string | null {
  if (content.trim() === "") {
    return "[invalid-cell-ref-syntax] Empty cell reference [].";
  }
  // No quotes → likely a dynamic/variable reference (e.g. !Year) — skip validation
  if (!content.includes("'")) {
    return null;
  }

  const singleElem = `'[^']+'\\s*:\\s*'[^']+'`;
  const multiElem = `'[^']+'\\s*:\\s*\\{\\s*'[^']+'(?:\\s*,\\s*'[^']+')*\\s*\\}`;
  const dimSpec = `(?:${multiElem}|${singleElem})`;
  const fullRe = new RegExp(`^\\s*${dimSpec}(?:\\s*,\\s*${dimSpec})*\\s*$`);

  if (fullRe.test(content)) {
    return null;
  }

  // Identify the offending sub-spec: split content on top-level commas, find
  // the first part that doesn't match the dimSpec pattern.
  const parts = splitTopLevelCommas(content);
  const partRe = new RegExp(`^\\s*${dimSpec}\\s*$`);
  for (const part of parts) {
    if (!partRe.test(part)) {
      return `[invalid-cell-ref-syntax] '${part.trim()}' does not match the format 'Dimension':'Element' or 'Dimension':{'E1','E2'}.`;
    }
  }
  return "[invalid-cell-ref-syntax] Cell reference does not match the format ['Dimension':'Element'] or ['Dimension':{'E1','E2'}].";
}

/** Splits a string by commas that are NOT inside `{...}` (brace-depth 0). */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.filter((p) => p.trim().length > 0);
}

/** Parsed dimension + element(s) from a single [...] spec. */
export interface BracketDimRef {
  dim: string;
  elems: string[];
}

/**
 * Parses 'DimName':'ElemName' pairs from a bracket ref content.
 * Only handles quoted string literals — dynamic refs are ignored.
 */
export function parseBracketDimRefs(content: string): BracketDimRef[] {
  const result: BracketDimRef[] = [];
  const dimSpecRe = /'([^']+)'\s*:\s*(?:'([^']+)'|\{([^}]+)\})/g;
  let m: RegExpExecArray | null;
  while ((m = dimSpecRe.exec(content)) !== null) {
    const dim = m[1]!;
    if (m[2] !== undefined) {
      result.push({ dim, elems: [m[2]] });
    } else if (m[3] !== undefined) {
      const elems = [...m[3].matchAll(/'([^']+)'/g)].map((r) => r[1]!);
      result.push({ dim, elems });
    }
  }
  return result;
}

// ─── Phase 2: DB() extraction ────────────────────────────────────────────────

interface DbCall {
  args: string[];
  cubeName: string | null; // null = not a string literal
}

/** Splits a comma-separated DB() argument string, respecting nested parens and quotes. */
function splitArgs(argsStr: string): string[] {
  if (!argsStr.trim()) {
    return [];
  }
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";

  for (const ch of argsStr) {
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      inString = false;
      current += ch;
    } else if (!inString && ch === "(") {
      depth++;
      current += ch;
    } else if (!inString && ch === ")") {
      depth--;
      current += ch;
    } else if (!inString && depth === 0 && ch === ",") {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  args.push(current.trim());
  return args.filter((a) => a !== "");
}

/**
 * Extracts all DB(...) calls from a line with their parsed arguments.
 * Uses neutralized positions to skip DB() inside strings/comments.
 */
export function extractDbCalls(line: string): DbCall[] {
  const neutralized = neutralizeLine(line);
  const results: DbCall[] = [];
  const dbRe = /\bDB\s*\(/gi;
  let m: RegExpExecArray | null;

  while ((m = dbRe.exec(neutralized)) !== null) {
    const openPos = m.index + m[0].length - 1; // index of '('
    let depth = 1;
    let i = openPos + 1;
    while (i < neutralized.length && depth > 0) {
      if (neutralized[i] === "(") {
        depth++;
      } else if (neutralized[i] === ")") {
        depth--;
      }
      i++;
    }
    if (depth !== 0) {
      continue;
    } // unmatched paren — skip

    const argsStr = line.slice(openPos + 1, i - 1);
    const args = splitArgs(argsStr);
    const first = args[0]?.trim() ?? "";
    const cubeName =
      first.startsWith("'") && first.endsWith("'") && first.length >= 3
        ? first.slice(1, -1)
        : null;

    results.push({ args, cubeName });
  }
  return results;
}
