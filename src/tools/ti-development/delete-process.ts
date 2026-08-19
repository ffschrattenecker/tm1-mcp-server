import { z } from "zod";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerDeleteProcess = defineTool({
  name: "tm1_delete_process",
  description: [
    "Delete a TurboIntegrator process from the TM1 server.",
    "Irreversible. Safety: pass confirm=<process name verbatim>. Mismatched confirm rejects the call.",
    "Before: tm1_analyze_object_usage to find chores or other processes that reference it; tm1_analyze_chore_graph to confirm no chore depends on it.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    processName: z.string().describe("Name of the TI process to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ processName, confirm }, tm1Client) => {
    requireConfirm(confirm, processName, "process");
    await tm1Client.processes.delete(processName);
    return actionResponse({ success: true, processName });
  },
});
