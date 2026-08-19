import { z } from "zod";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerDeleteDimension = defineTool({
  name: "tm1_delete_dimension",
  description: [
    "Delete a TM1 dimension and all its hierarchies. Warning: fails if the dimension is used in a cube.",
    "Before: tm1_find_orphan_dimensions to confirm the dimension is unused, or tm1_analyze_object_usage for a targeted check.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name (case-sensitive)"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ dimensionName, confirm }, tm1Client) => {
    requireConfirm(confirm, dimensionName, "dimension");
    await tm1Client.dimensions.delete(dimensionName);
    return actionResponse({ success: true, dimensionName });
  },
});
