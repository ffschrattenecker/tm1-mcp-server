// ─── String/comment neutralization ──────────────────────────────────────────

/** Replaces quoted strings with same-length spaces and strips trailing comments. */
export function neutralizeLine(line: string): string {
  return line
    .replace(/'[^']*'/g, (s) => " ".repeat(s.length))
    .replace(/#.*$/, "");
}
