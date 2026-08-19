import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { withToolHint } from "../error-format.js";

export const registerDeleteCube = defineTool({
  name: "tm1_delete_cube",
  description: [
    "Delete a TM1 cube and all its data. This action is irreversible.",
    "Safety: pass confirm=<cube name verbatim>. Mismatched confirm rejects the call.",
    "Before: tm1_analyze_object_usage to find rules or processes referencing the cube; tm1_get_cube_stats to size the data loss.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, confirm }, tm1Client) => {
    requireConfirm(confirm, cubeName, "cube");
    await withToolHint(
      tm1Client.cubes.delete(cubeName),
      "Cube delete failed. Common causes: cube still referenced by TI processes / chores / rules (run tm1_analyze_object_usage to inspect), insufficient permissions, or cube does not exist (tm1_list_cubes to verify name + casing).",
    );
    return actionResponse({ success: true, cubeName });
  },
});
