import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerDeleteSubset = defineTool({
  name: "tm1_delete_subset",
  description:
    "Delete a public TM1 subset. Fails if the subset is referenced by views/processes (404 if not found). Irreversible — pass confirm=<subset name verbatim>.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z.string().describe("Hierarchy name"),
    subsetName: z.string().describe("Subset to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { dimensionName, hierarchyName, subsetName, confirm },
    tm1Client,
  ) => {
    requireConfirm(confirm, subsetName, "subset");
    await tm1Client.subsets.delete(dimensionName, hierarchyName, subsetName);
    return actionResponse({ success: true, subsetName });
  },
});
