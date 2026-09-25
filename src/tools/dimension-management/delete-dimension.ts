import { z } from "zod";
import { actionResponse } from "../format.js";
import { DRY_RUN_CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { deleteImpact } from "../analysis/delete-impact.js";

export const registerDeleteDimension = defineTool({
  name: "tm1_delete_dimension",
  description: [
    "Delete a TM1 dimension and all its hierarchies. Warning: fails if the dimension is used in a cube.",
    "Before: dryRun=true lists the cubes that contain it and every process or rule that references it, in one call.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name (case-sensitive)"),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Delete nothing: return what references the dimension (processes and rules, per source) and the cubes it is part of. Needs no confirm and is not one.",
      ),
    ...DRY_RUN_CONFIRM_SCHEMA,
  },
  handler: async ({ dimensionName, dryRun, confirm }, tm1Client) => {
    if (dryRun) {
      return actionResponse({
        success: true,
        dryRun: true,
        dimensionName,
        needsConfirm: dimensionName,
        impact: await deleteImpact(tm1Client, "dimension", dimensionName),
      });
    }
    requireConfirm(confirm, dimensionName, "dimension");
    await tm1Client.dimensions.delete(dimensionName);
    return actionResponse({ success: true, dimensionName });
  },
});
