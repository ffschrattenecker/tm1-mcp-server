// Live checks for the 5.0.0 deploy-safety changes: the install preflight's
// reference check, confirm-on-overwrite for process installs, and the
// bulk_upsert_elements removal guard.
//
// Every object is SANDBOX-prefixed and removed in afterAll (sweepSandbox in
// global-setup is the safety net).
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type LiveHarness,
} from "./harness.js";

const PROC = `${SANDBOX}_R50_PROC`;
const GUARDED = `${SANDBOX}_R50_GUARDED`;
const NEW_DIM = `${SANDBOX}_R50_CREATED_DIM`;
const DIM = `${SANDBOX}_R50_DIM`;

describe.skipIf(!LIVE_ENABLED)("live: 5.0.0 deploy safety", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    for (const [tool, args] of [
      ["tm1_delete_process", { processName: PROC, confirm: PROC }],
      ["tm1_delete_process", { processName: GUARDED, confirm: GUARDED }],
      ["tm1_delete_dimension", { dimensionName: NEW_DIM, confirm: NEW_DIM }],
      ["tm1_delete_dimension", { dimensionName: DIM, confirm: DIM }],
    ] as const) {
      try {
        await h.call(tool, args);
      } catch {
        /* already gone */
      }
    }
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
  });

  afterAll(cleanup);

  it("creates a process without confirm", async () => {
    const r = await h.ok("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 1;",
    });
    expect(r.json.action).toBe("created");
  });

  it("refuses to overwrite it without confirm, and leaves it untouched", async () => {
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 2;",
    });
    expect(r.isError).toBe(true);
    expect(r.json.message).toContain(`needs confirm="${PROC}"`);
    const code = await h.ok("tm1_get_process_code", { processName: PROC });
    expect(code.json.prolog).toBe("nX = 1;");
  });

  it("preflight rejects a cube that does not exist, before writing", async () => {
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: "CellPutN(1, 'Sales Plan', 'a', 'b');",
      confirm: PROC,
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      stage: "preflight",
      check: "references",
      issues: [{ kind: "cube", name: "Sales Plan" }],
    });
    const code = await h.ok("tm1_get_process_code", { processName: PROC });
    expect(code.json.prolog).toBe("nX = 1;");
  });

  it("preflight checks the installed tabs the call leaves alone", async () => {
    await h.ok("tm1_upsert_process", {
      processName: PROC,
      epilog: "CellGetN('Sales Plan', 'a');",
      confirm: PROC,
      preflight: false,
    });
    // Only the prolog is sent; the installed epilog still names the cube.
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 3;",
      confirm: PROC,
    });
    expect(r.isError).toBe(true);
    expect(r.json.issues[0]).toMatchObject({
      name: "Sales Plan",
      tab: "epilog",
    });
  });

  it("passes a guard-created dimension", async () => {
    const r = await h.ok("tm1_upsert_process", {
      processName: GUARDED,
      prolog: [
        `sDim = '${NEW_DIM}';`,
        "IF(DimensionExists(sDim) = 0);",
        "  DimensionCreate(sDim);",
        "ENDIF;",
        "DimensionElementInsertDirect(sDim, '', 'A', 'N');",
      ].join("\r\n"),
    });
    expect(r.json.action).toBe("created");
    const refs = await h.ok("tm1_validate_process_refs", {
      processName: GUARDED,
    });
    expect(refs.json).toMatchObject({ unresolved: 0, partial: false });
  });

  it("check_process_code marks a fragment as partial", async () => {
    const r = await h.ok("tm1_check_process_code", { prolog: "nX = 1;" });
    expect(r.json).toMatchObject({
      ok: true,
      tabsChecked: ["prolog"],
      partial: true,
    });
  });

  it("bulk_upsert refuses to drop children without confirm; dryRun shows it", async () => {
    await h.ok("tm1_create_dimension", { dimensionName: DIM });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: DIM,
      elements: [
        { name: "A", type: "Numeric" },
        { name: "B", type: "Numeric" },
        {
          name: "Total",
          type: "Consolidated",
          components: [{ name: "A" }, { name: "B" }],
        },
      ],
    });
    const onlyA = {
      dimensionName: DIM,
      elements: [
        { name: "Total", type: "Consolidated", components: [{ name: "A" }] },
      ],
    };
    const dry = await h.ok("tm1_bulk_upsert_elements", {
      ...onlyA,
      dryRun: true,
    });
    expect(dry.json).toMatchObject({
      dryRun: true,
      creates: [],
      updates: ["Total"],
      removals: [{ parent: "Total", children: ["B"] }],
    });
    const refused = await h.call("tm1_bulk_upsert_elements", onlyA);
    expect(refused.isError).toBe(true);
    expect(refused.json.message).toContain("would remove 1 existing child");
    const still = await h.ok("tm1_get_descendants", {
      dimensionName: DIM,
      elementName: "Total",
    });
    expect(JSON.stringify(still.json)).toContain('"B"');

    await h.ok("tm1_bulk_upsert_elements", { ...onlyA, confirm: DIM });
    const after = await h.ok("tm1_bulk_upsert_elements", {
      ...onlyA,
      dryRun: true,
    });
    expect(after.json.removals).toEqual([]);
  });
});
