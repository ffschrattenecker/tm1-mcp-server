// Live check for the tm1_set_cube_rules preflight. Pins the TM1 behavior that
// motivates it: the Rules PATCH stores syntactically broken text without an
// error (verified on 11.8.03500), so CheckRules is the only gate. And the gap
// the preflight closes on top of it: CheckRules accepts a DB() with the wrong
// element count, and the rule then reads 0 without an error.
//
// Every object is SANDBOX-prefixed and removed in afterAll (sweepSandbox in
// global-setup is the safety net).
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cellValue,
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const CUBE = `${SANDBOX}_RP_CUBE`;
const ROW = `${SANDBOX}_RP_ROW`;
const MEAS = `${SANDBOX}_RP_MEAS`;
const GOOD = "SKIPCHECK;\n['Double'] = N: ['Amount'] * 2;\nFEEDERS;\n";
const BROKEN = "SKIPCHECK;\n['Double'] = N: ['Amount'] * 2 +;\nFEEDERS;\n";
const dbRule = (...elements: string[]) =>
  `SKIPCHECK;\n['Double'] = N: DB('${CUBE}', ${elements.join(", ")}) * 2;\nFEEDERS;\n`;

describe.skipIf(!LIVE_ENABLED)("live: set_cube_rules preflight", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    await dropIfExists(h, seg("Cubes", CUBE));
    await dropIfExists(h, seg("Dimensions", ROW));
    await dropIfExists(h, seg("Dimensions", MEAS));
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, ROW, ["R1"]);
    await createDimension(h, MEAS, ["Amount", "Double"]);
    await createCube(h, CUBE, [ROW, MEAS]);
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
    expect(r.json).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(JSON.parse(String(r.json.details))).toMatchObject({
      stage: "preflight",
      errors: [{ lineNumber: 2 }],
    });
    const back = await h.ok("tm1_get_cube_rules", { cubeName: CUBE });
    expect(String(back.json.rulesText).replace(/\r\n/g, "\n")).toBe(GOOD);
  });

  it("check_cube_rule reports the same error for the patch", async () => {
    const r = await h.call("tm1_check_cube_rule", {
      cubeName: CUBE,
      edits: [{ find: "* 2;", replace: "* 2 +;" }],
    });
    // A rule with errors is the answer, not a failed call.
    expect(r.isError).toBeFalsy();
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

  it("refuses a DB() with the wrong element count, which CheckRules accepts and which then reads 0", async () => {
    const short = dbRule(`!${ROW}`);
    const check = await h.ok("tm1_check_cube_rule", {
      cubeName: CUBE,
      rules: short,
    });
    // The one error is the element count: CheckRules itself found nothing.
    expect(check.json).toMatchObject({ ok: false, errorCount: 1 });
    expect(check.json.errors[0]).toMatchObject({ lineNumber: 2 });
    expect(check.json.errors[0].message).toMatch(
      /passes 1 element\(s\), the cube takes 2/,
    );

    const refused = await h.call("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      rules: short,
    });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: "VALIDATION_ERROR" });

    await h.ok("tm1_write_cells", {
      cubeName: CUBE,
      confirm: CUBE,
      dimensions: [ROW, MEAS],
      cells: [{ elements: ["R1", "Amount"], value: 5 }],
    });
    const double = () => cellValue(h, CUBE, [ROW, MEAS], ["R1", "Double"]);
    await h.ok("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      rules: short,
      preflight: false,
    });
    expect(await double()).toBeNull();
    await h.ok("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      rules: dbRule(`!${ROW}`, "'Amount'"),
    });
    expect(await double()).toBe(10);
  });
});
