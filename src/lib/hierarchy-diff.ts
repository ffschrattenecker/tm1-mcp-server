// Structural diff of two hierarchies, by set: elements, edges and weights.
// Names compare the way TM1 resolves them (case- and space-insensitive), and
// the A-side spelling is reported when both sides have the object. "added"
// means present in B only, "removed" present in A only — the same convention
// as the process diffs.
import type { HierarchyStructure } from "../tm1-client/services/hierarchy-service.js";
import { tm1NameKey } from "./tm1-name.js";

type Element = HierarchyStructure["elements"][number];
type Edge = HierarchyStructure["edges"][number];

export interface HierarchyDiff {
  elements: {
    added: Element[];
    removed: Element[];
    typeChanged: Array<{ name: string; a: string; b: string }>;
  };
  edges: {
    added: Edge[];
    removed: Edge[];
    weightChanged: Array<{
      parent: string;
      child: string;
      a: number;
      b: number;
    }>;
  };
  /**
   * Children whose set of parents differs on the two sides, while the child
   * itself exists on both — a move, as a modeller reads it. Derived from the
   * edge lists above, not additional to them.
   */
  reparented: Array<{ child: string; parentsA: string[]; parentsB: string[] }>;
}

const edgeKey = (e: Edge) =>
  `${tm1NameKey(e.parent)}\u0000${tm1NameKey(e.child)}`;

/** Child key → parent names, built once per side. */
function parentIndex(edges: Edge[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const e of edges) {
    const key = tm1NameKey(e.child);
    const list = index.get(key);
    if (list) list.push(e.parent);
    else index.set(key, [e.parent]);
  }
  return index;
}

export function diffHierarchies(
  a: HierarchyStructure,
  b: HierarchyStructure,
): HierarchyDiff {
  const elemA = new Map(a.elements.map((e) => [tm1NameKey(e.name), e]));
  const elemB = new Map(b.elements.map((e) => [tm1NameKey(e.name), e]));
  const diff: HierarchyDiff = {
    elements: { added: [], removed: [], typeChanged: [] },
    edges: { added: [], removed: [], weightChanged: [] },
    reparented: [],
  };

  for (const [key, eb] of elemB) {
    const ea = elemA.get(key);
    if (!ea) diff.elements.added.push(eb);
    else if (ea.type !== eb.type)
      diff.elements.typeChanged.push({ name: ea.name, a: ea.type, b: eb.type });
  }
  for (const [key, ea] of elemA)
    if (!elemB.has(key)) diff.elements.removed.push(ea);

  const edgeA = new Map(a.edges.map((e) => [edgeKey(e), e]));
  const edgeB = new Map(b.edges.map((e) => [edgeKey(e), e]));
  const touched = new Set<string>();
  for (const [key, xb] of edgeB) {
    const xa = edgeA.get(key);
    if (!xa) {
      diff.edges.added.push(xb);
      touched.add(tm1NameKey(xb.child));
    } else if (xa.weight !== xb.weight) {
      diff.edges.weightChanged.push({
        parent: xa.parent,
        child: xa.child,
        a: xa.weight,
        b: xb.weight,
      });
    }
  }
  for (const [key, xa] of edgeA) {
    if (edgeB.has(key)) continue;
    diff.edges.removed.push(xa);
    touched.add(tm1NameKey(xa.child));
  }

  if (touched.size > 0) {
    const parentsA = parentIndex(a.edges);
    const parentsB = parentIndex(b.edges);
    for (const child of touched) {
      const ea = elemA.get(child);
      if (!ea || !elemB.has(child)) continue;
      diff.reparented.push({
        child: ea.name,
        parentsA: (parentsA.get(child) ?? []).sort(),
        parentsB: (parentsB.get(child) ?? []).sort(),
      });
    }
  }

  const byName = (x: { name: string }, y: { name: string }) =>
    x.name.localeCompare(y.name);
  const byEdge = (
    x: { parent: string; child: string },
    y: { parent: string; child: string },
  ) => x.parent.localeCompare(y.parent) || x.child.localeCompare(y.child);
  diff.elements.added.sort(byName);
  diff.elements.removed.sort(byName);
  diff.elements.typeChanged.sort(byName);
  diff.edges.added.sort(byEdge);
  diff.edges.removed.sort(byEdge);
  diff.edges.weightChanged.sort(byEdge);
  diff.reparented.sort((x, y) => x.child.localeCompare(y.child));
  return diff;
}

export function isEmptyHierarchyDiff(d: HierarchyDiff): boolean {
  return (
    d.elements.added.length === 0 &&
    d.elements.removed.length === 0 &&
    d.elements.typeChanged.length === 0 &&
    d.edges.added.length === 0 &&
    d.edges.removed.length === 0 &&
    d.edges.weightChanged.length === 0
  );
}
