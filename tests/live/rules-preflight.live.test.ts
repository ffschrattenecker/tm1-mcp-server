// Live check for the tm1_set_cube_rules preflight. Pins the TM1 behavior that
// motivates it: the Rules PATCH stores syntactically broken text without an
// error (verified on 11.8.03500), so CheckRules is the only gate.
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

const CUBE = `${SANDBOX}_RP_CUBE`;
const ROW = `${SANDBOX}_RP_ROW`;
const MEAS = `${SANDBOX}_RP_MEAS`;
const GOOD = "SKIPCHECK;\n['Double'] = N: ['Amount'] * 2;\nFEEDERS;\n";
const BROKEN = "SKIPCHECK;\n['Double'] = N: ['Amount'] * 2 +;\nFEEDERS;\n";

describe.skipIf(!LIVE_ENABLED)("live: set_cube_rules preflight", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    for (const [tool, args] of [
      ["tm1_delete_cube", { cubeName: CUBE, confirm: CUBE }],
      ["tm1_delete_dimension", { dimensionName: ROW, confirm: ROW }],
      ["tm1_delete_dimension", { dimensionName: MEAS, confirm: MEAS }],
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
    await h.ok("tm1_create_dimension", { dimensionName: ROW });
    await h.ok("tm1_create_dimension", { dimensionName: MEAS });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: ROW,
      elements: [{ name: "R1", type: "Numeric" }],
    });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: MEAS,
      elements: [
        { name: "Amount", type: "Numeric" },
        { name: "Double", type: "Numeric" },
      ],
    });
    await h.ok("tm1_create_cube", { cubeName: CUBE, dimensions: [ROW, MEAS] });
    await h.ok("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      rules: GOOD,
    });
  });

  afterAll(cleanup);

  it("refuses broken text and leaves the stored rules untouched", async () => {
    const r = await h.call("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      edits: [{ find: "* 2;", replace: "* 2 +;" }],
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ stage: "preflight", check: "syntax" });
    const back = await h.ok("tm1_get_cube_rules", { cubeName: CUBE });
    expect(String(back.json.rulesText).replace(/\r\n/g, "\n")).toBe(GOOD);
  });

  it("check_cube_rule reports the same error for the patch", async () => {
    const r = await h.call("tm1_check_cube_rule", {
      cubeName: CUBE,
      edits: [{ find: "* 2;", replace: "* 2 +;" }],
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ ok: false, errors: [{ lineNumber: 2 }] });
  });

  it("TM1 itself stores the broken text when the preflight is off", async () => {
    await h.ok("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      rules: BROKEN,
      preflight: false,
    });
    const back = await h.ok("tm1_get_cube_rules", { cubeName: CUBE });
    expect(String(back.json.rulesText).replace(/\r\n/g, "\n")).toBe(BROKEN);
  });
});
