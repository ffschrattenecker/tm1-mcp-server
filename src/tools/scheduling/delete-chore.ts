import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerDeleteChore = defineTool({
  name: "tm1_delete_chore",
  description:
    "Delete a TM1 chore permanently. Irreversible — pass confirm=<chore name verbatim>.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    choreName: z.string().describe("Chore name (case-sensitive)"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ choreName, confirm }, tm1Client) => {
    requireConfirm(confirm, choreName, "chore");
    await tm1Client.chores.delete(choreName);
    return actionResponse({ success: true, choreName });
  },
});
