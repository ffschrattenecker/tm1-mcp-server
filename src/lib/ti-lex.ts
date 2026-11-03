// Low-level TI text lexing shared by the callgraph, rules, complexity and
// compat scanners: string literals, paren matching, separator splitting.
//
// TI facts this relies on:
//   - strings are single-quoted only; '' inside a string is an escaped quote;
//   - TI has no double-quoted strings, so " is an ordinary character;
//   - a string does not span lines: an unterminated one ends at end-of-line,
//     so it cannot swallow the rest of the text.

import { TI_VAR } from "./ti-identifier.js";

/** Caps the argument walk of callArgs so an unterminated call cannot scan a whole tab. */
const ARG_SCAN_MAX_CHARS = 2000;

/** Index of the last character of the string literal whose opening quote is at `open`. */
function stringEnd(text: string, open: number): number {
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\n") return j - 1;
    if (c === "'") {
      if (text[j + 1] === "'") {
        j++;
        continue;
      }
      return j;
    }
  }
  return text.length - 1;
}

/**
 * Index of the ')' closing the '(' at `openIdx`, or -1 when unbalanced.
 * Parens inside string literals are ignored. `limit` (exclusive) bounds the scan.
 */
export function matchParen(
  text: string,
  openIdx: number,
  limit = text.length,
): number {
  let depth = 0;
  for (let i = openIdx; i < limit; i++) {
    const c = text[i];
    if (c === "'") {
      i = stringEnd(text, i);
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Splits `text` at each `sep` outside string literals and at nesting depth 0.
 * `delims` picks the nesting pair: "()" for parens, "{}" for braces.
 * Pieces are returned raw (untrimmed); a trailing separator adds no piece.
 */
function splitRaw(text: string, sep: string, delims: "()" | "{}"): string[] {
  const [open, close] = delims;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      i = stringEnd(text, i);
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
    } else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Splits `text` at each top-level `sep` (outside string literals and nesting).
 * Pieces are trimmed; empty interior pieces are kept, a trailing empty piece is
 * dropped, and blank text yields no pieces.
 */
export function splitTopLevel(
  text: string,
  sep: string,
  delims: "()" | "{}" = "()",
): string[] {
  const parts = splitRaw(text, sep, delims).map((p) => p.trim());
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Raw texts of the arguments of the call whose '(' is at `openIdx`, or null
 * when the call is unterminated within ARG_SCAN_MAX_CHARS.
 */
export function callArgs(text: string, openIdx: number): string[] | null {
  const limit = Math.min(text.length, openIdx + 1 + ARG_SCAN_MAX_CHARS);
  const close = matchParen(text, openIdx, limit);
  if (close === -1) return null;
  return splitRaw(text.slice(openIdx + 1, close), ",", "()");
}

/**
 * The value of an argument that is exactly one TI string literal, with '' read
 * as '; null for anything else.
 */
export function quotedLiteral(argText: string): string | null {
  const m = /^\s*'((?:[^']|'')*)'\s*$/.exec(argText);
  return m ? m[1]!.replace(/''/g, "'") : null;
}

/** A section header line in a TI tab: `572,` / `573,n` / `574,n` / `575,n`. */
export const SECTION_MARKER_RE = /^57[2345],\d*$/;

/** `var = expression` with an optional trailing `;` and comment. */
export const ASSIGNMENT_RE = new RegExp(
  `^\\s*(${TI_VAR})\\s*=\\s*(.+?)\\s*;?\\s*(?:#.*)?$`,
);

/** Trims `s` and cuts it so that the result, ellipsis included, is at most `max` characters. */
export function truncateSnippet(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Start index of each standalone `keyword` (case-insensitive, not part of a
 * longer word) outside string literals. `keyword` is given in upper case.
 */
export function keywordPositions(text: string, keyword: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      i = stringEnd(text, i);
      continue;
    }
    const end = i + keyword.length;
    if (text.slice(i, end).toUpperCase() !== keyword) continue;
    if (/\w/.test(text[i - 1] ?? "") || /\w/.test(text[end] ?? "")) continue;
    found.push(i);
  }
  return found;
}
