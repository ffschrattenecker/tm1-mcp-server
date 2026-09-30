// Live lifecycle test for the CHORE (scheduling) domain. Drives the real MCP
// tool layer against a running TM1 server, exactly as an MCP client would.
//
// User intent (verbatim): "bitte einen internen test implementieren der jedes
// tool mit jeder funktionalität gegen den testserver live verprobt."
//
// Covers: tm1_update_chore, tm1_execute_chore, tm1_analyze_chore_graph
// (+ tm1_upsert_process for the prerequisite process). Create, activate,
// deactivate and delete go through tm1_rest_write.
//
// SAFETY: every object is prefixed with `${SANDBOX}_CHORE`. The chore is
// created DEACTIVATED (Active:false) and afterAll deletes it, so it can never
// fire on a schedule after the test. The bound process is harmless: prolog
// `nX = 1;`, no data source. Teardown is idempotent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  restGet,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const PROC = `${SANDBOX}_CHORE_PROC`;
const CHORE = `${SANDBOX}_CHORE_A`;
// Far-future start time, explicit UTC offset, deactivated → never auto-runs.
const START = "2099-01-01T06:00:00Z";

interface ChoreRow {
  Name: string;
  Active: boolean;
  StartTime: string;
  Tasks: Array<{ Process?: { Name: string } }>;
}

describe.skipIf(!LIVE_ENABLED)("live: chore lifecycle", () => {
  let h: LiveHarness;

  const chore = () =>
    restGet<ChoreRow>(
      h,
      `${seg("Chores", CHORE)}?$select=Name,Active,StartTime&$expand=Tasks($expand=Process($select=Name))`,
    );

  beforeAll(async () => {
    h = await getHarness();
    // Prerequisite: a harmless process for the chore to reference.
    await h.ok("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 1;",
      mode: "upsert",
    });
  });

  afterAll(async () => {
    // Idempotent teardown. Delete the chore FIRST so it can never fire, then
    // the process.
    await dropIfExists(h, seg("Chores", CHORE));
    await dropIfExists(h, seg("Processes", PROC));
  });

  it("creates a deactivated chore bound to the process", async () => {
    await restWrite(h, "POST", "Chores", {
      Name: CHORE,
      StartTime: START,
      DSTSensitive: false,
      Active: false, // never auto-runs
      ExecutionMode: "SingleCommit",
      Frequency: "P1DT00H00M00S",
      Tasks: [
        {
          Step: 0,
          "Process@odata.bind": seg("Processes", PROC),
          Parameters: [],
        },
      ],
    });
    const c = await chore();
    expect(c.Active).toBe(false);
    expect(c.Tasks.map((t) => t.Process?.Name)).toEqual([PROC]);
  });

  it("activates and deactivates the chore", async () => {
    await restWrite(h, "POST", `${seg("Chores", CHORE)}/tm1.Activate`, {});
    expect((await chore()).Active).toBe(true);
    // Deactivate again (leave it OFF — schedule must never fire post-test).
    await restWrite(h, "POST", `${seg("Chores", CHORE)}/tm1.Deactivate`, {});
    expect((await chore()).Active).toBe(false);
  });

  it("update_chore changes the start time", async () => {
    const NEW_START = "2099-06-15T09:30:00Z";
    const r = await h.ok("tm1_update_chore", {
      choreName: CHORE,
      startTime: NEW_START,
    });
    expect(r.json).toMatchObject({ success: true, choreName: CHORE });
    // Verify it stuck. TM1 may render the StartTime in its own format/zone,
    // so assert the date portion rather than an exact string match.
    expect(String((await chore()).StartTime)).toContain("2099-06-15");
  });

  it("execute_chore runs it once on demand and reports how it ended", async () => {
    // Chore is deactivated; on-demand execute bypasses the schedule.
    const r = await h.ok("tm1_execute_chore", {
      choreName: CHORE,
      confirm: CHORE,
    });
    // What comes back depends on the server, and both answers are correct:
    // v12 12.5.0+ has tm1.ExecuteWithReturn on Chore and reports a real status
    // (this chore's step is `nX = 1;`, so a clean one); anything older cannot
    // report at all and says so rather than claiming success. The commit
    // semantics behind the status live in chore-exit-status.live.test.ts.
    if (r.json?.statusUnavailable === true) {
      expect(r.json).toMatchObject({
        success: false,
        outcome: "indeterminate",
      });
      expect(r.json.choreErrorStatus).toMatch(/12\.5\.0/);
    } else {
      expect(r.json).toMatchObject({
        success: true,
        outcome: "succeeded",
        choreErrorStatus: "CompletedSuccessfully",
      });
    }
  });

  it("analyze_chore_graph returns task structure", async () => {
    const r = await h.ok("tm1_analyze_chore_graph", { choreName: CHORE });
    expect(r.json.choreName).toBeTruthy();
    expect(Array.isArray(r.json.tasks)).toBe(true);
    expect(r.json.tasks.length).toBeGreaterThanOrEqual(1);
    const t0 = r.json.tasks[0];
    expect(t0.processName).toBe(PROC);
    expect(t0.tree).toBeTruthy();
  });
});
