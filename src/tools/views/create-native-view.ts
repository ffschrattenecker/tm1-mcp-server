import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";

const AXIS_SPEC = z.object({
  dimension: z.string().describe("Dimension name"),
  hierarchy: z
    .string()
    .optional()
    .describe(
      "Hierarchy name (default: same-named hierarchy as the dimension)",
    ),
  subset: z
    .string()
    .optional()
    .describe(
      "Registered subset name. Exactly one of subset/expression/elements per axis entry.",
    ),
  expression: z
    .string()
    .optional()
    .describe(
      "MDX set expression for an anonymous subset, e.g. '{TM1SUBSETALL([Region])}'",
    ),
  elements: z
    .array(z.string())
    .optional()
    .describe("Explicit element list for an anonymous subset"),
});

const TITLE_SPEC = AXIS_SPEC.extend({
  selected: z
    .string()
    .describe(
      "Element shown as the title's selection; must be in the subset. Required — TM1 rejects title subsets without a selected element.",
    ),
});

export const registerCreateNativeView = defineTool({
  name: "tm1_create_native_view",
  description:
    "Create a public native (subset-based) view on a cube — the classic view type used as TI process datasource " +
    "(TM1CubeView) and for zero-suppressed exports. Every cube dimension must appear in exactly one of " +
    "columns/rows/titles, each axis entry with exactly one subset source: a registered subset name, an MDX " +
    "expression, or an explicit element list (the latter two create anonymous subsets). " +
    "For MDX-defined views use tm1_create_mdx_view instead.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube the view belongs to"),
    viewName: z.string().describe("New view name"),
    columns: z
      .array(AXIS_SPEC)
      .min(1)
      .describe("Column axis, one entry per dimension"),
    rows: z
      .array(AXIS_SPEC)
      .min(1)
      .describe("Row axis, one entry per dimension"),
    titles: z
      .array(TITLE_SPEC)
      .optional()
      .describe(
        "Title (context) dimensions, each with a required selected element",
      ),
    suppressEmptyColumns: z
      .boolean()
      .optional()
      .default(false)
      .describe("Suppress columns where all cells are empty/zero"),
    suppressEmptyRows: z
      .boolean()
      .optional()
      .default(false)
      .describe("Suppress rows where all cells are empty/zero"),
    formatString: z
      .string()
      .optional()
      .describe("Cell format string, e.g. '0.#########'"),
  },
  handler: async (
    {
      cubeName,
      viewName,
      columns,
      rows,
      titles,
      suppressEmptyColumns,
      suppressEmptyRows,
      formatString,
    },
    tm1Client,
  ) => {
    await tm1Client.views.createNative(cubeName, viewName, {
      columns,
      rows,
      titles,
      suppressEmptyColumns,
      suppressEmptyRows,
      formatString,
    });
    return actionResponse({ success: true, cubeName, viewName });
  },
});
