import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerUpdateSubset = defineTool({
  name: "tm1_update_subset",
  description:
    "Update an existing TM1 subset in place, public by default or private with isPrivate=true. The way to change a subset a view uses, since TM1 will not delete that one. Pass expression to replace the MDX, OR elements to replace the static list (order kept; an MDX subset becomes static; [] empties it) — not both. Pass alias to change the alias attribute. If the new list names an unknown element, TM1 refuses it and the old definition is written back.",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z.string().describe("Hierarchy name"),
    subsetName: z.string().describe("Existing subset name"),
    expression: z.string().optional().describe("New MDX expression"),
    elements: z
      .array(z.string())
      .optional()
      .describe(
        "New static element list; replaces the old one and turns an MDX subset static. Mutually exclusive with expression.",
      ),
    alias: z.string().optional().describe("New alias attribute"),
    isPrivate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Update in PrivateSubsets (owned by the signed-in user) instead of public Subsets",
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
    await tm1Client.subsets.update(
      dimensionName,
      hierarchyName,
      subsetName,
      { expression, elements, alias },
      isPrivate ?? false,
    );
    return actionResponse({ success: true, subsetName });
  },
});
