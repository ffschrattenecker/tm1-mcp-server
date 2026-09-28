import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import {
  diffHierarchies,
  isEmptyHierarchyDiff,
} from "../../lib/hierarchy-diff.js";
import { tm1NameEquals, tm1NameKey } from "../../lib/tm1-name.js";
import { DiffHierarchyResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

// Attribute values are read a window at a time; one MDX per window.
const ATTRIBUTE_PAGE = 5000;

type Values = Map<string, { name: string; values: Record<string, unknown> }>;

async function readAttributeValues(
  client: TM1Client,
  dimension: string,
  attributeNames: string[],
): Promise<Values> {
  const out: Values = new Map();
  for (let offset = 0; ; offset += ATTRIBUTE_PAGE) {
    const page = await client.elements.getAttributeValuesPage(dimension, {
      offset,
      limit: ATTRIBUTE_PAGE,
      attributeNames,
    });
    for (const item of page.items)
      out.set(tm1NameKey(item.elementName), {
        name: item.elementName,
        values: item.values,
      });
    if (offset + ATTRIBUTE_PAGE >= page.total) return out;
  }
}

export const registerDiffHierarchy = defineTool({
  name: "tm1_diff_hierarchy",
  description: [
    "Diff a hierarchy between two connections (connectionB, e.g. DEV vs PROD) or against another dimension (dimensionB): elements added/removed/retyped, edges added/removed, weight changes, reparented children, and attribute definitions. Computed server-side; returns counts plus lists capped at limit.",
    "'added' = only in B, 'removed' = only in A. Names compare case- and space-insensitively, as in TM1.",
  ],
  annotations: READ_ONLY,
  peer: true,
  output: DiffHierarchyResultSchema,
  input: {
    dimension: z.string().describe("Dimension name."),
    hierarchy: z
      .string()
      .optional()
      .describe("Hierarchy name. Default: the dimension's own hierarchy."),
    dimensionB: z
      .string()
      .optional()
      .describe(
        "Dimension to compare against, read from connectionB. Default: the same dimension.",
      ),
    includeAttributeValues: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Also compare attribute values of elements on both sides (default false; one MDX per 5000 elements per side). Default hierarchy only.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(100)
      .describe("Most entries per list (default 100); counts stay exact."),
  },
  handler: async (
    {
      dimension,
      hierarchy,
      dimensionB: dimensionBArg,
      includeAttributeValues,
      limit,
    },
    { a, b },
  ) => {
    const dimensionB = dimensionBArg ?? dimension;
    const hierarchyA = hierarchy ?? dimension;
    const hierarchyB = hierarchy ?? dimensionB;
    if (
      includeAttributeValues &&
      (!tm1NameEquals(hierarchyA, dimension) ||
        !tm1NameEquals(hierarchyB, dimensionB))
    ) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "includeAttributeValues reads the default hierarchy only; omit hierarchy or set includeAttributeValues=false.",
      });
    }

    const [structA, structB, attrsA, attrsB] = await Promise.all([
      a.client.hierarchies.getStructure(dimension, hierarchyA),
      b.client.hierarchies.getStructure(dimensionB, hierarchyB),
      a.client.elements.listAttributes(dimension, hierarchyA),
      b.client.elements.listAttributes(dimensionB, hierarchyB),
    ]);
    const diff = diffHierarchies(structA, structB);

    const defsA = new Map(attrsA.map((x) => [tm1NameKey(x.name), x]));
    const defsB = new Map(attrsB.map((x) => [tm1NameKey(x.name), x]));
    const attributes = {
      added: attrsB.filter((x) => !defsA.has(tm1NameKey(x.name))),
      removed: attrsA.filter((x) => !defsB.has(tm1NameKey(x.name))),
      typeChanged: attrsA.flatMap((x) => {
        const y = defsB.get(tm1NameKey(x.name));
        return y && y.type !== x.type
          ? [{ name: x.name, a: x.type, b: y.type }]
          : [];
      }),
    };

    let valueChanges:
      | Array<{ element: string; attribute: string; a: unknown; b: unknown }>
      | undefined;
    if (includeAttributeValues) {
      const shared = attrsA
        .filter((x) => defsB.has(tm1NameKey(x.name)))
        .map((x) => x.name);
      valueChanges = [];
      if (shared.length > 0) {
        const [valsA, valsB] = await Promise.all([
          readAttributeValues(a.client, dimension, shared),
          readAttributeValues(
            b.client,
            dimensionB,
            shared.map((n) => defsB.get(tm1NameKey(n))!.name),
          ),
        ]);
        for (const [key, rowA] of valsA) {
          const rowB = valsB.get(key);
          if (!rowB) continue; // element added/removed is reported above
          for (const attr of shared) {
            const va = rowA.values[attr] ?? "";
            const vb = rowB.values[defsB.get(tm1NameKey(attr))!.name] ?? "";
            if (va !== vb)
              valueChanges.push({
                element: rowA.name,
                attribute: attr,
                a: va,
                b: vb,
              });
          }
        }
        valueChanges.sort(
          (x, y) =>
            x.element.localeCompare(y.element) ||
            x.attribute.localeCompare(y.attribute),
        );
      }
    }

    const lists = {
      elementsAdded: diff.elements.added,
      elementsRemoved: diff.elements.removed,
      elementTypeChanged: diff.elements.typeChanged,
      edgesAdded: diff.edges.added,
      edgesRemoved: diff.edges.removed,
      weightChanged: diff.edges.weightChanged,
      reparented: diff.reparented,
      attributesAdded: attributes.added,
      attributesRemoved: attributes.removed,
      attributeTypeChanged: attributes.typeChanged,
      ...(valueChanges ? { attributeValueChanged: valueChanges } : {}),
    };
    const counts = Object.fromEntries(
      Object.entries(lists).map(([k, v]) => [k, v.length]),
    );
    const truncated = Object.values(lists).some((v) => v.length > limit);
    const identical =
      isEmptyHierarchyDiff(diff) &&
      attributes.added.length === 0 &&
      attributes.removed.length === 0 &&
      attributes.typeChanged.length === 0 &&
      (valueChanges?.length ?? 0) === 0;

    const side = (
      connection: string,
      dim: string,
      hier: string,
      s: typeof structA,
    ) => ({
      connection,
      dimension: dim,
      hierarchy: hier,
      elements: s.elements.length,
      edges: s.edges.length,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              a: side(a.name, dimension, hierarchyA, structA),
              b: side(b.name, dimensionB, hierarchyB, structB),
              identical,
              counts,
              ...Object.fromEntries(
                Object.entries(lists)
                  .filter(([, v]) => v.length > 0)
                  .map(([k, v]) => [k, v.slice(0, limit)]),
              ),
              ...(truncated ? { truncated: true } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
