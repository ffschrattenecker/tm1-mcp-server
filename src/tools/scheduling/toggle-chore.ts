import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerToggleChore = defineTool({
  name: "tm1_toggle_chore",
  description:
    "Activate or deactivate a TM1 chore (enable/disable its schedule).",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    choreName: z.string().describe("Chore name (case-sensitive)"),
    active: z
      .boolean()
      .describe("true to activate scheduling, false to deactivate"),
  },
  handler: async ({ choreName, active }, tm1Client) => {
    await tm1Client.chores.toggleActive(choreName, active);
    return actionResponse({ success: true, choreName, active });
  },
});
