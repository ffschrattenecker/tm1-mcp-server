// Scheduling-domain schemas: chore list item for tm1_list_chores, run result
// for tm1_execute_chore.
import { z } from "zod";
import { ChoreSchema } from "../../schemas/scheduling.js";
import { CHORE_OUTCOME } from "./items-common.js";

// In compact mode (tm1_list_chores compact=true) the full processes[] array is
// replaced by processCount, so both are optional at schema level; the tool
// guarantees exactly one is present.
export const ChoreItemSchema = ChoreSchema.partial({ processes: true }).extend({
  processCount: z.number().int().optional(),
});

// Result of tm1_execute_chore. `choreErrorStatus` carries TM1's raw
// ChoreExecuteStatusCode, or — when the outcome is indeterminate — the reason
// it is unknown, since there is no separate hint field.
export const ChoreResultSchema = z.object({
  success: z.boolean(),
  outcome: CHORE_OUTCOME,
  choreErrorStatus: z.string(),
  // Present on every v12 chore run, successful ones included: a chore always
  // writes a ChoreLog. Its presence is not a failure signal.
  errorLogFile: z.string().optional(),
  // true = the server cannot report chore status at all (v11, and v12 before
  // 12.5.0). The chore ran; how it ended is unknown.
  statusUnavailable: z.boolean().optional(),
});
