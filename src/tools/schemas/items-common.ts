// Shared primitives referenced across the per-category item schemas.
// Split out of items.ts so every category file can import the same
// enums/unions and the uniform mutation envelope without a cycle.
import { z } from "zod";

// Canonical domain primitives — defined once in src/schemas/ and re-exported
// here so the per-category item schemas keep their existing import path.
export {
  CellValueSchema,
  ELEMENT_TYPE,
  PARAM_TYPE,
} from "../../schemas/common.js";

// Outcome axis of a TI run — mirrors `ProcessOutcome` in src/types.ts, where
// the measured status-code mapping is documented. All three non-success values
// travel alongside `success: false` (fail-closed); they differ on the question
// the caller actually has, which is whether anything was committed:
// "completed_with_errors" = the run's changes WERE committed (retrying is
// unsafe), "rolled_back" = nothing was, "indeterminate" = unknown.
export const PROCESS_OUTCOME = z.enum([
  "succeeded",
  "completed_with_errors",
  "rolled_back",
  "indeterminate",
]);

// ── Phase 2h: uniform mutation envelope ──────────────────────────────────────
// Every create/update/delete/execute tool returns {success: true, ...identifying fields}
// on success. Passthrough so per-tool extras (cellsWritten, parameterCount,
// updatedTabs etc.) flow through without bespoke schemas.
export const MutationResultSchema = z
  .object({
    success: z.boolean(),
  })
  .passthrough();
