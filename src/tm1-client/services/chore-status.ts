// Classification of TM1's `ChoreExecuteStatusCode`.
//
// This is NOT `process-status.ts` with different names, and the two must never
// be merged. A chore reports on a different axis than a process, and the codes
// that look identical do not mean the same thing. Measured against v12 12.5.9
// on 2026-08-21, with the identical TI bodies run standalone as a control:
//
//   TI body in the step   standalone process        inside a chore
//   ───────────────────   ───────────────────────   ─────────────────────────────
//   (clean)               CompletedSuccessfully ✓   CompletedSuccessfully  ✓
//   ItemReject            CompletedWithMessages ✓   CompletedSuccessfully  ✓
//   ProcessQuit           QuitCalled            ✓   CompletedWithMessages  ✓
//   ProcessError          Aborted               ✗   CompletedWithMessages  ✓
//   CellPutN → no cube    Aborted               ✗   CompletedWithMessages  ✓
//   ProcessRollback       RollbackCalled        ✗   ProcessRollbackCalled  ✗
//                                               ↑                          ↑
//                                    ✓ = the step's writes survived the run
//
// Two findings drive everything below, and neither is guessable from the names:
//
//  1. A step that ABORTS commits its writes. `ProcessError` and a write into a
//     missing cube both roll back when the process runs on its own; inside a
//     chore the marker cell written just before the abort is still there
//     afterwards, and the chore calls it `CompletedWithMessages`. Mapping
//     chore statuses through the process table would therefore report
//     `rolled_back` for a run that committed — the exact fail-open T-4 closed
//     for processes, reintroduced from the other side.
//
//  2. Chores do NOT stop at a failing step. With the failing process as step 1
//     and a clean writer as step 2, step 2 ran and committed in every case, in
//     both execution modes. (`tm1_execute_chore` used to tell callers the
//     opposite.)
//
// `ProcessRollbackCalled` is the only status that reports discarded writes, and
// how much it discards is the one place `ExecutionMode` shows through:
//   SingleCommit   — everything the chore had written up to that point is gone.
//   MultipleCommit — only the rolling-back step's own writes are gone.
// Later steps run and commit under both. Measured in both modes.
import { CHORE_STATUS_UNKNOWN } from "../../types.js";
import type { ChoreResult } from "../../types.js";

/**
 * Statuses observed on a run whose writes were COMMITTED.
 *
 * `CompletedWithMessages` is what a chore returns for a step that quit AND for
 * a step that aborted — the two are indistinguishable at chore level, so a
 * caller who needs to know which step did what has to read the chore log.
 */
const COMMITTED_STATUSES: ReadonlySet<string> = new Set([
  "CompletedWithMessages",
]);

/** Statuses observed on a run whose writes were DISCARDED. */
const ROLLED_BACK_STATUSES: ReadonlySet<string> = new Set([
  "ProcessRollbackCalled",
]);

/**
 * Members of `tm1.ChoreExecuteStatusCode` that the measurement never produced.
 *
 * They are declared in v12's `$metadata`, so they are real names, but no TI
 * exit path drove a chore to any of them: `ProcessQuit` surfaced as
 * `CompletedWithMessages`, `ProcessError` likewise, `ProcessRollback` as
 * `ProcessRollbackCalled`. Whether `Aborted`, `RollbackCalled` or a chore-level
 * `QuitCalled` commit is therefore UNMEASURED, and this file does not guess:
 * the whole reason the two tables are separate is that the obvious reading —
 * "Aborted must mean rolled back, it does for processes" — is demonstrably
 * wrong one line up. They classify as `indeterminate` with that said out loud.
 */
const DECLARED_BUT_UNOBSERVED: ReadonlySet<string> = new Set([
  "QuitCalled",
  "Aborted",
  "RollbackCalled",
]);

/**
 * Turn TM1's `ChoreExecuteStatusCode` into a `ChoreResult`.
 *
 * Mirrors `classifyExecution`'s three fail-open guards — absent status is not
 * success, a non-`CompletedSuccessfully` code is not a flat failure, and an
 * unrecognised code is never a guess — but over the chore table above, not the
 * process one.
 */
export function classifyChoreExecution(
  statusCode: string | undefined,
  errorLogFile: string | undefined,
): ChoreResult {
  if (statusCode === undefined || statusCode === "") {
    return {
      success: false,
      outcome: "indeterminate",
      choreErrorStatus: CHORE_STATUS_UNKNOWN,
      errorLogFile,
    };
  }
  if (statusCode === "CompletedSuccessfully") {
    return {
      success: true,
      outcome: "succeeded",
      choreErrorStatus: "CompletedSuccessfully",
      errorLogFile,
    };
  }
  if (COMMITTED_STATUSES.has(statusCode)) {
    return {
      success: false,
      outcome: "completed_with_errors",
      choreErrorStatus: statusCode,
      errorLogFile,
    };
  }
  if (ROLLED_BACK_STATUSES.has(statusCode)) {
    return {
      success: false,
      outcome: "rolled_back",
      choreErrorStatus: statusCode,
      errorLogFile,
    };
  }
  if (DECLARED_BUT_UNOBSERVED.has(statusCode)) {
    return {
      success: false,
      outcome: "indeterminate",
      choreErrorStatus: `${statusCode}: declared in tm1.ChoreExecuteStatusCode but never produced by any measured chore exit path, so whether a chore ending this way commits its writes is unknown. Chore statuses do NOT follow the process ones — a chore step that aborts reports CompletedWithMessages and COMMITS. Verify server state before re-running.`,
      errorLogFile,
    };
  }
  return {
    success: false,
    outcome: "indeterminate",
    choreErrorStatus: `${statusCode}: unrecognised ChoreExecuteStatusCode — this build does not know whether a chore ending this way commits its changes. Verify server state before re-running.`,
    errorLogFile,
  };
}
