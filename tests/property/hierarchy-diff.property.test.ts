/**
 * diffHierarchies is a set diff: a hierarchy diffed with itself is empty, and
 * swapping the sides swaps added with removed and mirrors every change.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  diffHierarchies,
  isEmptyHierarchyDiff,
} from "../../src/lib/hierarchy-diff.js";
import type { HierarchyStructure } from "../../src/tm1-client/services/hierarchy-service.js";

const name = fc.constantFrom("A", "B", "C", "D", "E", "F", "G", "H");
const hierarchy: fc.Arbitrary<HierarchyStructure> = fc.record({
  elements: fc.uniqueArray(
    fc.record({
      name,
      type: fc.constantFrom(
        "Numeric" as const,
        "String" as const,
        "Consolidated" as const,
      ),
    }),
    { selector: (e) => e.name },
  ),
  edges: fc.uniqueArray(
    fc.record({
      parent: name,
      child: name,
      weight: fc.constantFrom(1, -1, 0.5),
    }),
    { selector: (e) => `${e.parent}/${e.child}` },
  ),
});

describe("diffHierarchies properties", () => {
  it("diff(x, x) is empty", () => {
    fc.assert(
      fc.property(hierarchy, (h) => {
        const d = diffHierarchies(h, h);
        expect(isEmptyHierarchyDiff(d)).toBe(true);
        expect(d.reparented).toEqual([]);
      }),
    );
  });

  it("diff(b, a) mirrors diff(a, b)", () => {
    fc.assert(
      fc.property(hierarchy, hierarchy, (a, b) => {
        const ab = diffHierarchies(a, b);
        const ba = diffHierarchies(b, a);
        expect(ba.elements.added).toEqual(ab.elements.removed);
        expect(ba.elements.removed).toEqual(ab.elements.added);
        expect(ba.edges.added).toEqual(ab.edges.removed);
        expect(ba.edges.removed).toEqual(ab.edges.added);
        expect(ba.elements.typeChanged).toEqual(
          ab.elements.typeChanged.map((t) => ({
            name: t.name,
            a: t.b,
            b: t.a,
          })),
        );
        expect(ba.edges.weightChanged).toEqual(
          ab.edges.weightChanged.map((w) => ({ ...w, a: w.b, b: w.a })),
        );
      }),
    );
  });
});
