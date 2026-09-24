import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { HIERARCHY_NAME_OPTIONAL, resolveHierarchy } from "../hierarchy.js";
export const registerUpdateSubset = defineTool({
  name: "tm1_update_subset",
  description:
    "Update a public TM1 subset (partial). Pass expression to replace the MDX, or elements to switch the subset to a static list (resets Expression to ''). Pass alias to change the alias attribute.",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    ...HIERARCHY_NAME_OPTIONAL,
    subsetName: z.string().describe("Existing subset name"),
    expression: z.string().optional().describe("New MDX expression"),
    elements: z
      .array(z.string())
      .optional()
      .describe("New static element list (clears MDX)"),
    alias: z.string().optional().describe("New alias attribute"),
  },
  handler: async (
    { dimensionName, hierarchyName, subsetName, expression, elements, alias },
    tm1Client,
  ) => {
    const hierarchy = resolveHierarchy(dimensionName, hierarchyName);
    await tm1Client.subsets.update(dimensionName, hierarchy, subsetName, {
      expression,
      elements,
      alias,
    });
    return actionResponse({ success: true, subsetName });
  },
});
