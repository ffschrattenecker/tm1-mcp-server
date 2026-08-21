// Live CHORE EXIT STATUS tier: the measurement behind `ChoreOutcome`.
//
// Sibling of process-exit-status.live.test.ts, and deliberately a separate
// file, because the two mappings are NOT the same. The same TI body run
// standalone and run as a chore step reports a different status AND a different
// commit outcome — measured on 12.5.9, 2026-08-21:
//
//   TI body            standalone process        as a chore step
//   ────────────────   ───────────────────────   ────────────────────────────
//   (clean)            CompletedSuccessfully ✓   CompletedSuccessfully  ✓
//   ItemReject         CompletedWithMessages ✓   CompletedSuccessfully  ✓
//   ProcessQuit        QuitCalled            ✓   CompletedWithMessages  ✓
//   ProcessError       Aborted               ✗   CompletedWithMessages  ✓
//   CellPutN no cube   Aborted               ✗   CompletedWithMessages  ✓
//   ProcessRollback    RollbackCalled        ✗   ProcessRollbackCalled  ✗
//                                            ↑                          ↑
//                                  ✓ = the step's write survived the run
//
// Read the ProcessError row twice. A step that ABORTS commits its writes inside
// a chore. That is the finding this suite exists to keep honest: classify chore
// statuses through the process table and a committed run is reported as rolled
// back, which is an invitation to re-run it.
//
// Requires `tm1.ExecuteWithReturn` on Chore — v12 12.5.0 and up. On anything
// older the whole suite skips rather than asserting the fallback, which is
// covered by unit tests (tests/unit/chore-result-outcome.test.ts).
//
// COVERAGE: three of the six members of tm1.ChoreExecuteStatusCode are reached
// here — CompletedSuccessfully, CompletedWithMessages, ProcessRollbackCalled.
// `QuitCalled`, `Aborted` and `RollbackCalled` are declared in $metadata but no
// exit path produced them, which is exactly why `classifyChoreExecution` files
// them under indeterminate instead of guessing. If a future build starts
// emitting one, the UNOBSERVED test below is what notices.
//
// Everything is created under the `${SANDBOX}_CHEXIT` prefix and removed again.
// The chore is created DEACTIVATED so it can never fire on a schedule.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type CallResult,
  type LiveHarness,
} from "./harness.js";

const PREFIX = `${SANDBOX}_CHEXIT`;
const DIM_A = `${PREFIX}_DA`;
const DIM_B = `${PREFIX}_DB`;
const CUBE = `${PREFIX}_CUBE`;
const CHORE = `${PREFIX}_CH`;
// Deliberately never created — a CellPutN into it is the "bad cube" abort.
const MISSING_CUBE = `${PREFIX}_NOSUCHCUBE`;
// Step 1 in the fail-fast probe; writes the M1 marker and nothing else.
const CLEAN_STEP = `${PREFIX}_M1`;
// Far-future start, deactivated → never auto-runs.
const START = "2099-01-01T06:00:00Z";

interface ChoreCase {
  name: string;
  /** TI appended after the step's marker write. */
  body: string;
  status: string;
  outcome: "succeeded" | "completed_with_errors" | "rolled_back";
  /** true = the step's marker write survived (the chore committed it). */
  committed: boolean;
}

// Every failure here is a FINDING about the server, not a broken test.
const finding = (c: ChoreCase, what: string): string =>
  [
    `${c.name}: TM1 disagreed with the measured chore mapping for ${what}.`,
    "This is a FINDING, not a broken test: record the actual value and the",
    "server version, then decide whether classifyChoreExecution's grouping is",
    "still right. Do NOT relax this assertion to make it pass. Note that the",
    "chore mapping is independent of the process one — do not 'fix' it by",
    "copying process-status.ts.",
  ].join(" ");

const CASES: readonly ChoreCase[] = [
  {
    name: "CLEAN",
    body: "",
    status: "CompletedSuccessfully",
    outcome: "succeeded",
    committed: true,
  },
  // Standalone this is CompletedWithMessages; a chore rounds it up to clean.
  {
    name: "ITEMREJECT",
    body: "ItemReject('probe');",
    status: "CompletedSuccessfully",
    outcome: "succeeded",
    committed: true,
  },
  {
    name: "QUIT",
    body: "ProcessQuit;",
    status: "CompletedWithMessages",
    outcome: "completed_with_errors",
    committed: true,
  },
  // The important pair: standalone both are Aborted with a full rollback.
  {
    name: "ERROR",
    body: "ProcessError;",
    status: "CompletedWithMessages",
    outcome: "completed_with_errors",
    committed: true,
  },
  {
    name: "BADCUBE",
    body: `CellPutN(1, '${MISSING_CUBE}', 'M2', 'F1');`,
    status: "CompletedWithMessages",
    outcome: "completed_with_errors",
    committed: true,
  },
  {
    name: "ROLLBACK",
    body: "ProcessRollback;",
    status: "ProcessRollbackCalled",
    outcome: "rolled_back",
    committed: false,
  },
];

const stepProc = (name: string): string => `${PREFIX}_${name}`;

describe.skipIf(!LIVE_ENABLED)(
  "live: chore exit status → commit semantics",
  () => {
    let h: LiveHarness;
    let supported = false;

    const runChore = async (
      tasks: string[],
      executionMode: "SingleCommit" | "MultipleCommit",
    ): Promise<CallResult> => {
      // Reset both markers. Writing 0 EMPTIES the cell — TM1 stores no zeros — so
      // a post-run read is null unless THIS run's write survived.
      await h.ok("tm1_write_cells", {
        cubeName: CUBE,
        dimensions: [DIM_A, DIM_B],
        cells: [
          { elements: ["M1", "F1"], value: 0 },
          { elements: ["M2", "F1"], value: 0 },
        ],
        confirm: CUBE,
      });
      await h.call("tm1_delete_chore", { choreName: CHORE, confirm: CHORE });
      await h.ok("tm1_create_chore", {
        choreName: CHORE,
        startTime: START,
        active: false,
        executionMode,
        frequency: { days: 1, hours: 0, minutes: 0, seconds: 0 },
        steps: tasks.map((p) => ({ process: p, parameters: [] })),
      });
      return h.call("tm1_execute_chore", {
        choreName: CHORE,
        confirm: CHORE,
        timeoutMs: 120000,
      });
    };

    const marker = async (element: string): Promise<unknown> => {
      const res = await h.ok("tm1_get_cell_value", {
        cubeName: CUBE,
        elements: [element, "F1"],
      });
      return res.json?.value ?? null;
    };

    beforeAll(async () => {
      h = await getHarness();
      // Leftovers from an interrupted run (idempotent).
      await h.call("tm1_delete_chore", { choreName: CHORE, confirm: CHORE });
      await h.call("tm1_delete_cube", { cubeName: CUBE, confirm: CUBE });
      for (const d of [DIM_A, DIM_B]) {
        await h.call("tm1_delete_dimension", { dimensionName: d, confirm: d });
      }

      await h.ok("tm1_create_dimension", { dimensionName: DIM_A });
      await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM_A,
        // M1 belongs to the clean step, M2 to the step under test — the fail-fast
        // probe needs to tell the two apart.
        elements: [
          { name: "M1", type: "Numeric" },
          { name: "M2", type: "Numeric" },
        ],
      });
      await h.ok("tm1_create_dimension", { dimensionName: DIM_B });
      await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM_B,
        elements: [{ name: "F1", type: "Numeric" }],
      });
      await h.ok("tm1_create_cube", {
        cubeName: CUBE,
        dimensions: [DIM_A, DIM_B],
      });

      await h.ok("tm1_upsert_process", {
        processName: CLEAN_STEP,
        prolog: `CellPutN(11, '${CUBE}', 'M1', 'F1');\r\n`,
        mode: "upsert",
      });
      for (const c of CASES) {
        // Marker write FIRST, then the exit: whether 22 survives is the question.
        await h.ok("tm1_upsert_process", {
          processName: stepProc(c.name),
          prolog: `CellPutN(22, '${CUBE}', 'M2', 'F1');\r\n${c.body}\r\n`,
          mode: "upsert",
        });
      }

      // Capability probe: one clean single-step run. A build without
      // tm1.ExecuteWithReturn reports statusUnavailable, and every assertion
      // below would then be measuring the fallback instead of the server.
      const probe = await runChore([stepProc("CLEAN")], "SingleCommit");
      supported = probe.json?.statusUnavailable !== true;
    });

    afterAll(async () => {
      await h.call("tm1_delete_chore", { choreName: CHORE, confirm: CHORE });
      for (const p of [CLEAN_STEP, ...CASES.map((c) => stepProc(c.name))]) {
        await h.call("tm1_delete_process", { processName: p, confirm: p });
      }
      await h.call("tm1_delete_cube", { cubeName: CUBE, confirm: CUBE });
      for (const d of [DIM_A, DIM_B]) {
        await h.call("tm1_delete_dimension", { dimensionName: d, confirm: d });
      }
    });

    for (const mode of ["SingleCommit", "MultipleCommit"] as const) {
      for (const c of CASES) {
        it(`${mode}/${c.name}: reports ${c.status} (${c.outcome}) and ${
          c.committed ? "keeps" : "discards"
        } the write`, async () => {
          if (!supported) {
            // v11, or v12 before 12.5.0 — nothing to measure here.
            return;
          }
          const run = await runChore([stepProc(c.name)], mode);

          // Raw server fact first, so a red run names what TM1 said rather than
          // what this build concluded from it.
          expect(
            run.json?.choreErrorStatus,
            finding(c, "ChoreExecuteStatusCode"),
          ).toBe(c.status);
          expect(run.json?.outcome, finding(c, "the derived outcome")).toBe(
            c.outcome,
          );
          expect(run.json?.success, finding(c, "success")).toBe(
            c.outcome === "succeeded",
          );
          expect(
            await marker("M2"),
            finding(c, "whether the write committed"),
          ).toBe(c.committed ? 22 : null);

          // A chore writes a ChoreLog on EVERY run, clean ones included — so this
          // field's presence is not a failure signal, unlike a process's error log.
          expect(run.json?.errorLogFile, finding(c, "the chore log")).toMatch(
            /^ChoreLog_/,
          );
        });
      }

      // Chores do not stop at a failing step. The tool used to claim they do.
      it(`${mode}: a failing step does NOT stop the chore — later steps run and commit`, async () => {
        if (!supported) return;
        // Failing step FIRST, clean writer SECOND: M1 can only be set if the
        // chore carried on past the failure.
        const run = await runChore([stepProc("ERROR"), CLEAN_STEP], mode);
        expect(run.json?.choreErrorStatus).toBe("CompletedWithMessages");
        expect(await marker("M1")).toBe(11);
      });

      // ExecutionMode is visible in exactly one place: how far a rollback reaches.
      it(`${mode}: a rolling-back LAST step ${
        mode === "SingleCommit"
          ? "discards the earlier step too"
          : "spares the earlier step"
      }`, async () => {
        if (!supported) return;
        const run = await runChore([CLEAN_STEP, stepProc("ROLLBACK")], mode);
        expect(run.json?.choreErrorStatus).toBe("ProcessRollbackCalled");
        expect(await marker("M2")).toBeNull();
        expect(await marker("M1")).toBe(mode === "SingleCommit" ? null : 11);
      });
    }

    // Guards the classifier's honesty rather than the server's behaviour: these
    // three are declared in tm1.ChoreExecuteStatusCode but no exit path above
    // produced them. If one starts appearing, it needs measuring, not guessing.
    it("no exit path produces QuitCalled, Aborted or RollbackCalled at chore level", async () => {
      if (!supported) return;
      const seen: string[] = [];
      for (const c of CASES) {
        const run = await runChore([stepProc(c.name)], "SingleCommit");
        seen.push(String(run.json?.choreErrorStatus));
      }
      for (const unobserved of ["QuitCalled", "Aborted", "RollbackCalled"]) {
        expect(
          seen,
          `${unobserved} now appears at chore level. It is currently classified as indeterminate because it was never observed — measure whether it commits, then move it into the right set in chore-status.ts.`,
        ).not.toContain(unobserved);
      }
    });
  },
);
