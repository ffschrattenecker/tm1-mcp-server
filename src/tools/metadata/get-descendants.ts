import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  type Column,
} from "../format.js";
import { DescendantsResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetDescendants = defineTool({
  name: "tm1_get_descendants",
  description: [
    "Get descendants of a consolidation element. Token-efficient alternative to tm1_get_hierarchy when you only need a subtree.",
    "depth caps how many levels below the start element are returned (depth=1 = direct children).",
    "leavesOnly=true keeps only N-elements (no consolidations). Multi-parent hierarchies: each unique element appears once.",
    "Result capped to topN (default 1000) with truncated=true when the cap clips — raise topN for more.",
    "Output: { element, descendants: [{ name, type, level, depth }], truncated }.",
  ],
  annotations: READ_ONLY,
  output: DescendantsResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the TM1 dimension"),
    hierarchyName: z.string().describe("Hierarchy within the dimension"),
    elementName: z
      .string()
      .describe(
        "Start element (typically a consolidation). Numeric/leaf elements return empty descendants.",
      ),
    depth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max depth below the start element. Omit for unlimited."),
    leavesOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return only leaf elements (no consolidations)."),
    topN: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1000)
      .describe(
        "Max descendants returned (default 1000). Caps large subtrees; result sets truncated=true when the cap clipped the set. Raise to fetch more.",
      ),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    {
      dimensionName,
      hierarchyName,
      elementName,
      depth,
      leavesOnly,
      topN,
      format,
    },
    tm1Client,
  ) => {
    const full = await tm1Client.hierarchies.getDescendants(
      dimensionName,
      hierarchyName,
      elementName,
      {
        ...(depth !== undefined ? { depth } : {}),
        ...(leavesOnly !== undefined ? { leavesOnly } : {}),
      },
    );
    // The traversal is client-side (BFS over the fetched hierarchy), so the
    // full descendant set is known here — truncated is exact, not a heuristic.
    const truncated = full.descendants.length > topN;
    const result = {
      element: full.element,
      descendants: truncated
        ? full.descendants.slice(0, topN)
        : full.descendants,
      truncated,
    };
    type Row = (typeof result.descendants)[number];
    const columns: Column<Row>[] = [
      { header: "name", get: (d) => d.name },
      { header: "type", get: (d) => d.type },
      { header: "level", get: (d) => d.level },
      { header: "depth", get: (d) => d.depth },
    ];
    return payloadResponse(
      result,
      format,
      (r) =>
        `## Descendants of ${r.element}\n\n${r.descendants.length} elements\n\n${renderTable(r.descendants, columns)}`,
    );
  },
});
