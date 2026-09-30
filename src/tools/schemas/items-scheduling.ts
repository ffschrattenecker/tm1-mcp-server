// Scheduling-domain schemas: run result for tm1_execute_chore.
import { z } from "zod";
import { CHORE_OUTCOME } from "./items-common.js";

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
