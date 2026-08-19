import { z } from "zod";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerExecuteChore = defineTool({
  name: "tm1_execute_chore",
  description: [
    "Execute a TM1 chore immediately, bypassing its schedule.",
    "Non-idempotent: runs every chained process. Before: tm1_analyze_chore_graph to preview the call chain.",
    "On failure: tm1_diagnose_process_error for the failing step (chores fail-fast on first error).",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    choreName: z.string().describe("Chore name (case-sensitive)"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override the default 30s request timeout for this call (ms, 1000–3600000). Use for chores running long TI chains.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ choreName, timeoutMs, confirm }, tm1Client, extra) => {
    // Runs every chained process; undoing the call does not undo the writes.
    // Guards against accidental invocation — not a security control.
    requireConfirm(confirm, choreName, "chore");
    await tm1Client.chores.execute(choreName, {
      signal: extra?.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return actionResponse({ success: true, choreName });
  },
});
