// Answers the two request shapes HierarchyService uses for a flat element
// pool (each element lists its Parents, as TM1 returns them):
//   - the whole hierarchy (`Hierarchies('H')?$expand=Elements(...)`)
//   - one element with Components or Parents expanded N levels deep
//     (`Elements('X')?$select=...&$expand=Components(...)`), trimmed to the
//     number of `$expand=` clauses in the URL like TM1 does.
// Returns undefined for an unknown element, so callers can answer 404.
export interface PoolElement {
  Name: string;
  Type: string;
  Level: number;
  Parents: Array<{ Name: string }>;
}

export function answerHierarchy(pool: PoolElement[], rawUrl: string): unknown {
  const url = decodeURIComponent(rawUrl);
  const m = url.match(/\/Elements\('((?:[^']|'')*)'\)\?/);
  if (!m) return { Name: "H", Elements: pool };
  const name = m[1].replace(/''/g, "'");
  const byName = new Map(pool.map((e) => [e.Name, e]));
  if (!byName.has(name)) return undefined;
  const nav = url.includes("$expand=Parents") ? "Parents" : "Components";
  const levels = (url.match(/\$expand=/g) ?? []).length;
  const children = (n: string) =>
    nav === "Parents"
      ? byName.get(n)!.Parents.map((p) => p.Name)
      : pool
          .filter((e) => e.Parents.some((p) => p.Name === n))
          .map((e) => e.Name);
  const build = (n: string, depth: number): Record<string, unknown> => {
    const e = byName.get(n)!;
    const node: Record<string, unknown> = {
      Name: e.Name,
      Type: e.Type,
      Level: e.Level,
    };
    if (depth < levels) {
      node[nav] = children(n)
        .filter((c) => byName.has(c))
        .map((c) => build(c, depth + 1));
    }
    return node;
  };
  return build(name, 0);
}
