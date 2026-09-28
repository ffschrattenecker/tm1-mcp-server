import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { HIERARCHY_NAME_OPTIONAL, resolveHierarchy } from "../hierarchy.js";
export const registerDeleteSubset = defineTool({
  name: "tm1_delete_subset",
  description:
    "Delete a TM1 subset, public by default or private with isPrivate=true. TM1 refuses to delete a subset a view still uses (SubsetIsBeingUsedByView) — change it with tm1_update_subset instead. 404 if not found. Irreversible — pass confirm=<subset name verbatim>.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    ...HIERARCHY_NAME_OPTIONAL,
    subsetName: z.string().describe("Subset to delete"),
    isPrivate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Use PrivateSubsets (the signed-in user's) instead of public Subsets",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { dimensionName, hierarchyName, subsetName, isPrivate, confirm },
    tm1Client,
  ) => {
    const hierarchy = resolveHierarchy(dimensionName, hierarchyName);
    requireConfirm(confirm, subsetName, "subset");
    await tm1Client.subsets.delete(
      dimensionName,
      hierarchy,
      subsetName,
      isPrivate ?? false,
    );
    return actionResponse({ success: true, subsetName });
  },
});
