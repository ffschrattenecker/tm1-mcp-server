import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { HIERARCHY_NAME_OPTIONAL, resolveHierarchy } from "../hierarchy.js";
export const registerCreateSubset = defineTool({
  name: "tm1_create_subset",
  description:
    "Create a TM1 subset, public by default or private with isPrivate=true (private subsets belong to the signed-in user and are invisible to others; the same name may exist once public and once private). Provide either expression (MDX-based, dynamic) OR elements (static list) — not both. Optional alias attribute name controls the displayed alias.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    ...HIERARCHY_NAME_OPTIONAL,
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
    isPrivate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Use PrivateSubsets (the signed-in user's) instead of public Subsets",
      ),
  },
  handler: async (
    {
      dimensionName,
      hierarchyName,
      subsetName,
      expression,
      elements,
      alias,
      isPrivate,
    },
    tm1Client,
  ) => {
    await tm1Client.subsets.create(
      dimensionName,
      resolveHierarchy(dimensionName, hierarchyName),
      {
        name: subsetName,
        expression,
        elements,
        alias,
      },
      isPrivate ?? false,
    );
    return actionResponse({
      success: true,
      subsetName,
      kind: expression ? "mdx" : "static",
    });
  },
});
