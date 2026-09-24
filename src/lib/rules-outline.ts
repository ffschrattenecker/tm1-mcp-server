// Navigation over a cube's rule text without shipping all of it: an outline of
// section markers, and line-range slices. A 130 KB rule file overflowed the
// client's result cap three times in recorded usage; the outline plus one or
// two slices is what an edit actually needs.

/** Upper bound on outline entries; a rule file of 5000 one-line comments must not become a 5000-entry outline. */
export const OUTLINE_MAX_ENTRIES = 200;
const OUTLINE_TEXT_MAX = 100;

export interface OutlineEntry {
  /** 1-based line number. */
  line: number;
  text: string;
}

const DIRECTIVE = /^\s*(SKIPCHECK|FEEDERS|FEEDSTRINGS|UNDEFVALS)\s*;/i;
// A comment line that carries no words: `####`, `# =====`, `#-----`.
const DECORATION = /^\s*#[\s#=\-*~_+.]*$/;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Section markers: the rule directives (SKIPCHECK, FEEDERS, FEEDSTRINGS,
 * UNDEFVALS) and the first worded line of every comment block — a run of
 * consecutive `#` lines is how rule files label what follows. Decoration-only
 * lines are skipped in favor of the block's first line with words in it.
 */
export function outlineRules(text: string): {
  outline: OutlineEntry[];
  truncated: boolean;
} {
  const lines = splitLines(text);
  const outline: OutlineEntry[] = [];
  let inBlock = false;
  let blockLabelled = false;
  let truncated = false;
  const push = (i: number) => {
    if (outline.length >= OUTLINE_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    const t = lines[i]!.trim();
    outline.push({
      line: i + 1,
      text:
        t.length > OUTLINE_TEXT_MAX ? `${t.slice(0, OUTLINE_TEXT_MAX)}…` : t,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isComment = /^\s*#/.test(line);
    if (!isComment) {
      inBlock = false;
      if (DIRECTIVE.test(line)) push(i);
      continue;
    }
    if (!inBlock) {
      inBlock = true;
      blockLabelled = false;
    }
    if (!blockLabelled && !DECORATION.test(line)) {
      push(i);
      blockLabelled = true;
    }
  }
  return { outline, truncated };
}

/**
 * Lines `from`..`to` (1-based, inclusive), clamped to the text. Returns the
 * slice verbatim — no line-number prefixes — so it can be quoted back into a
 * `find` string for a rules patch.
 */
export function sliceLines(
  text: string,
  from: number,
  to: number,
): { text: string; from: number; to: number } {
  const lines = splitLines(text);
  const start = Math.max(1, Math.min(from, lines.length));
  const end = Math.max(start, Math.min(to, lines.length));
  return { text: lines.slice(start - 1, end).join("\n"), from: start, to: end };
}
