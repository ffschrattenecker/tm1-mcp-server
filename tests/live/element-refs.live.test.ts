// Live check for the element-literal reference check (validate_process_refs
// and the install preflight). Pins the TM1 behavior that motivates it: a TI
// cell call with an element that does not exist does not abort — the process
// ends HasMinorErrors and the value is not written (verified on 11.8.03500).
// Also pins the resolution rules against a real server: an alias and a
// differently cased/spaced name resolve; TI cell calls leave out Sandboxes.
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

const CUBE = `${SANDBOX}_ER_CUBE`;
const REGION = `${SANDBOX}_ER_REGION`;
const MEAS = `${SANDBOX}_ER_MEAS`;
const PROC = `${SANDBOX}_ER_PROC`;

describe.skipIf(!LIVE_ENABLED)("live: element reference check", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    for (const [tool, args] of [
      ["tm1_delete_process", { processName: PROC, confirm: PROC }],
      ["tm1_delete_cube", { cubeName: CUBE, confirm: CUBE }],
      ["tm1_delete_dimension", { dimensionName: REGION, confirm: REGION }],
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
    await h.ok("tm1_create_dimension", { dimensionName: REGION });
    await h.ok("tm1_create_dimension", { dimensionName: MEAS });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: REGION,
      elements: [{ name: "North America", type: "Numeric" }],
    });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: MEAS,
      elements: [{ name: "Amount", type: "Numeric" }],
    });
    await h.ok("tm1_create_element_attribute", {
      dimensionName: REGION,
      attributeName: "Code",
      attributeType: "Alias",
    });
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: REGION,
      elementName: "North America",
      attributeName: "Code",
      value: "NA",
    });
    await h.ok("tm1_create_cube", {
      cubeName: CUBE,
      dimensions: [REGION, MEAS],
    });
  });

  afterAll(cleanup);

  it("validate_process_refs reports a missing element with its dimension", async () => {
    const r = await h.ok("tm1_validate_process_refs", {
      content: [
        "601,100",
        `602,"${PROC}"`,
        "572,1",
        `CellPutN(1, '${CUBE}', 'Asia', 'Amount');`,
        "573,0",
        "574,0",
        "575,0",
      ].join("\r\n"),
    });
    expect(r.json.issues).toMatchObject([
      { kind: "element", name: "Asia", dimension: REGION },
    ]);
  });

  it("the install preflight refuses it, and nothing is installed", async () => {
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: `CellPutN(1, '${CUBE}', 'Asia', 'Amount');`,
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ stage: "preflight", check: "references" });
    expect(r.json.message).toMatch(
      new RegExp(`element 'Asia' in dimension '${REGION}'`),
    );
    const exists = await h.call("tm1_get_process", { processName: PROC });
    expect(exists.isError).toBe(true);
  });

  it("passes an alias, a case/space variant, and an element the code inserts", async () => {
    const r = await h.ok("tm1_upsert_process", {
      processName: PROC,
      prolog: [
        `CellPutN(1, '${CUBE}', 'NA', 'Amount');`,
        `CellPutN(2, '${CUBE}', 'northamerica', 'AMOUNT');`,
        `DimensionElementInsert('${REGION}', '', 'Asia', 'N');`,
      ].join("\n"),
      epilog: `CellPutN(3, '${CUBE}', 'Asia', 'Amount');`,
    });
    expect(r.json.action).toBe("created");
  });
});
