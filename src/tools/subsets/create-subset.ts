import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
export const registerCreateSubset = defineTool({
  name: "tm1_create_subset",
  description:
    "Create a public TM1 subset. Provide either expression (MDX-based, dynamic) OR elements (static list) — not both. Optional alias attribute name controls the displayed alias.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z.string().describe("Hierarchy name"),
    subsetName: z.string().describe("New subset name"),
    expression: z
      .string()
      .optional()
      .describe(
        "MDX expression (e.g. '{TM1FILTERBYLEVEL({TM1SUBSETALL([Dim])}, 0)}'). Mutually exclusive with elements.",
      ),
    elements: z
      .array(z.string())
      .optional()
      .describe(
        "Static element name list. Mutually exclusive with expression.",
      ),
    alias: z
      .string()
      .optional()
      .describe("Alias attribute used as display name in the subset"),
  },
  handler: async (
    { dimensionName, hierarchyName, subsetName, expression, elements, alias },
    tm1Client,
  ) => {
    await tm1Client.subsets.create(dimensionName, hierarchyName, {
      name: subsetName,
      expression,
      elements,
      alias,
    });
    return actionResponse({
      success: true,
      subsetName,
      kind: expression ? "mdx" : "static",
    });
  },
});
