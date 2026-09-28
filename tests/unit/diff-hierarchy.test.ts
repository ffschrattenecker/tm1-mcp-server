import { describe, expect, it } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import type { HierarchyStructure } from "../../src/tm1-client/services/hierarchy-service.js";
import { registerDiffHierarchy } from "../../src/tools/analysis/diff-hierarchy.js";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { peerRunner } from "../helpers/peer-tool.js";

function client(opts: {
  structure: HierarchyStructure;
  attributes?: Array<{ name: string; type: "Numeric" | "String" | "Alias" }>;
  values?: Record<string, Record<string, string | number>>;
}): TM1Client {
  const rows = Object.entries(opts.values ?? {}).map(
    ([elementName, values]) => ({
      elementName,
      values,
    }),
  );
  return contractCheckedClient({
    hierarchies: { getStructure: async () => opts.structure },
    elements: {
      listAttributes: async () => opts.attributes ?? [],
      getAttributeValuesPage: async (
        _dim: string,
        p: { offset: number; limit: number },
      ) => ({
        total: rows.length,
        items: rows.slice(p.offset, p.offset + p.limit),
      }),
    },
  } as unknown as TM1Client);
}

const structure = (children: string[]): HierarchyStructure => ({
  elements: [
    { name: "Total", type: "Consolidated" },
    ...children.map((name) => ({ name, type: "Numeric" as const })),
  ],
  edges: children.map((child) => ({ parent: "Total", child, weight: 1 })),
});

describe("tm1_diff_hierarchy", () => {
  it("reports counts, lists capped at limit, and connections", async () => {
    const run = peerRunner(registerDiffHierarchy, {
      dev: client({ structure: structure(["A", "B", "C", "D"]) }),
      prod: client({ structure: structure(["A"]) }),
    });
    const r = await run<Record<string, unknown>>({
      dimension: "Region",
      connection: "prod",
      connectionB: "dev",
      limit: 2,
    });
    expect(r.identical).toBe(false);
    expect(r.a).toMatchObject({ connection: "prod", elements: 2, edges: 1 });
    expect(r.b).toMatchObject({ connection: "dev", elements: 5, edges: 4 });
    expect(r.counts).toMatchObject({ elementsAdded: 3, edgesAdded: 3 });
    expect(r.elementsAdded).toHaveLength(2);
    expect(r.truncated).toBe(true);
    // Empty lists are left out entirely.
    expect(r).not.toHaveProperty("elementsRemoved");
  });

  it("compares attribute definitions and, when asked, values", async () => {
    const attrs = [{ name: "Caption", type: "Alias" as const }];
    const run = peerRunner(registerDiffHierarchy, {
      dev: client({
        structure: structure(["A"]),
        attributes: [...attrs, { name: "Manager", type: "String" }],
        values: { A: { Caption: "Alpha" } },
      }),
      prod: client({
        structure: structure(["A"]),
        attributes: attrs,
        values: { a: { Caption: "Alpha (old)" } },
      }),
    });
    const r = await run<Record<string, unknown>>({
      dimension: "Region",
      connection: "prod",
      connectionB: "dev",
      includeAttributeValues: true,
    });
    expect(r.attributesAdded).toEqual([{ name: "Manager", type: "String" }]);
    expect(r.attributeValueChanged).toEqual([
      { element: "a", attribute: "Caption", a: "Alpha (old)", b: "Alpha" },
    ]);
  });

  it("refuses attribute values on a non-default hierarchy", async () => {
    const run = peerRunner(registerDiffHierarchy, {
      dev: client({ structure: structure([]) }),
      prod: client({ structure: structure([]) }),
    });
    await expect(
      run({
        dimension: "Region",
        hierarchy: "ByManager",
        connection: "dev",
        includeAttributeValues: true,
      }),
    ).rejects.toThrow(/default hierarchy only/);
  });
});
