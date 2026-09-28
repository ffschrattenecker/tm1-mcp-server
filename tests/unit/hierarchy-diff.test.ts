import { describe, expect, it } from "vitest";
import {
  diffHierarchies,
  isEmptyHierarchyDiff,
} from "../../src/lib/hierarchy-diff.js";
import type { HierarchyStructure } from "../../src/tm1-client/services/hierarchy-service.js";

const base: HierarchyStructure = {
  elements: [
    { name: "Total", type: "Consolidated" },
    { name: "North", type: "Consolidated" },
    { name: "South", type: "Consolidated" },
    { name: "Vienna", type: "Numeric" },
    { name: "Graz", type: "Numeric" },
  ],
  edges: [
    { parent: "Total", child: "North", weight: 1 },
    { parent: "Total", child: "South", weight: 1 },
    { parent: "North", child: "Vienna", weight: 1 },
    { parent: "South", child: "Graz", weight: 1 },
  ],
};

describe("diffHierarchies", () => {
  it("is empty for the same hierarchy, even with different spelling", () => {
    const respelled: HierarchyStructure = {
      elements: base.elements.map((e) => ({
        ...e,
        name: e.name.toUpperCase(),
      })),
      edges: base.edges.map((e) => ({
        ...e,
        child: ` ${e.child.toLowerCase()}`,
      })),
    };
    expect(isEmptyHierarchyDiff(diffHierarchies(base, respelled))).toBe(true);
  });

  it("reports a move as one removed and one added edge, and as reparented", () => {
    const moved: HierarchyStructure = {
      elements: base.elements,
      edges: base.edges.map((e) =>
        e.child === "Graz" ? { ...e, parent: "North" } : e,
      ),
    };
    const d = diffHierarchies(base, moved);
    expect(d.edges.removed).toEqual([
      { parent: "South", child: "Graz", weight: 1 },
    ]);
    expect(d.edges.added).toEqual([
      { parent: "North", child: "Graz", weight: 1 },
    ]);
    expect(d.reparented).toEqual([
      { child: "Graz", parentsA: ["South"], parentsB: ["North"] },
    ]);
    expect(d.elements.added).toEqual([]);
  });

  it("reports weight and type changes, and added/removed elements", () => {
    const b: HierarchyStructure = {
      elements: [
        { name: "Total", type: "Consolidated" },
        { name: "North", type: "Consolidated" },
        { name: "South", type: "Consolidated" },
        { name: "Vienna", type: "String" },
        { name: "Linz", type: "String" },
      ],
      edges: [
        { parent: "Total", child: "North", weight: 1 },
        { parent: "Total", child: "South", weight: -1 },
        { parent: "North", child: "Vienna", weight: 1 },
      ],
    };
    const d = diffHierarchies(base, b);
    expect(d.elements.added).toEqual([{ name: "Linz", type: "String" }]);
    expect(d.elements.removed).toEqual([{ name: "Graz", type: "Numeric" }]);
    expect(d.elements.typeChanged).toEqual([
      { name: "Vienna", a: "Numeric", b: "String" },
    ]);
    expect(d.edges.weightChanged).toEqual([
      { parent: "Total", child: "South", a: 1, b: -1 },
    ]);
    // Graz's edge is gone with it, but Graz no longer exists: not a move.
    expect(d.reparented).toEqual([]);
  });
});
