// Live check for the element-literal reference check (validate_process_refs
// and the install preflight). Pins the TM1 behavior that motivates it: a TI
// cell call with an element that does not exist does not abort — the process
// ends HasMinorErrors and the value is not written (verified on 11.8.03500).
// Also pins the resolution rules against a real server: an alias and a
// differently cased/spaced name resolve; TI cell calls leave out Sandboxes.
// And the two run-time failures the compiler passes: a cell call with the
// wrong element count aborts the run, and an attribute write on an element
// inserted earlier in the same Prolog fails until the tab commits.
//
// Every object is SANDBOX-prefixed and removed in afterAll (sweepSandbox in
// global-setup is the safety net).
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const CUBE = `${SANDBOX}_ER_CUBE`;
const REGION = `${SANDBOX}_ER_REGION`;
const MEAS = `${SANDBOX}_ER_MEAS`;
const PROC = `${SANDBOX}_ER_PROC`;
const RUN_PROC = `${SANDBOX}_ER_RUN`;
// Never installed: the preflight must refuse it before anything is written.
const REFUSED_PROC = `${SANDBOX}_ER_REFUSED`;

describe.skipIf(!LIVE_ENABLED)("live: element reference check", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    await dropIfExists(h, seg("Processes", PROC));
    await dropIfExists(h, seg("Processes", RUN_PROC));
    await dropIfExists(h, seg("Processes", REFUSED_PROC));
    await dropIfExists(h, seg("Cubes", CUBE));
    await dropIfExists(h, seg("Dimensions", REGION));
    await dropIfExists(h, seg("Dimensions", MEAS));
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, REGION, ["North America"]);
    await createDimension(h, MEAS, ["Amount"]);
    await restWrite(
      h,
      "POST",
      `${seg("Dimensions", REGION)}/${seg("Hierarchies", REGION)}/ElementAttributes`,
      { Name: "Code", Type: "Alias" },
    );
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: REGION,
      elementName: "North America",
      attributeName: "Code",
      value: "NA",
    });
    await createCube(h, CUBE, [REGION, MEAS]);
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

  // Installs RUN_PROC past the preflight and runs it: what TM1 itself does.
  const runUnchecked = async (prolog: string) => {
    const exists = !(await h.call("tm1_get_process", { processName: RUN_PROC }))
      .isError;
    await h.ok("tm1_upsert_process", {
      processName: RUN_PROC,
      prolog,
      preflight: false,
      ...(exists ? { confirm: RUN_PROC } : {}),
    });
    return h.call("tm1_execute_process", {
      processName: RUN_PROC,
      confirm: RUN_PROC,
    });
  };

  it("flags a cell call with the wrong element count, which TM1 compiles and then aborts on", async () => {
    const code = `x = CellGetN('${CUBE}', 'NA');`;
    const r = await h.ok("tm1_validate_process_refs", {
      content: [
        "601,100",
        `602,"${PROC}"`,
        "572,1",
        code,
        "573,0",
        "574,0",
        "575,0",
      ].join("\r\n"),
    });
    expect(r.json.issues).toMatchObject([
      { kind: "elementCount", name: CUBE, expected: 2, got: 1 },
    ]);

    const refused = await h.call("tm1_upsert_process", {
      processName: REFUSED_PROC,
      prolog: code,
    });
    expect(refused.isError).toBe(true);
    expect(refused.json.message).toMatch(
      /passes 1 element\(s\), the cube takes 2/,
    );

    const run = await runUnchecked(code);
    expect(run.json).toMatchObject({ processErrorStatus: "Aborted" });
    expect(JSON.stringify(run.json)).toMatch(
      /Wrong Number of Dimension Elements/,
    );
  });

  it("flags an attribute write on an element the same Prolog inserts, which fails until the tab commits", async () => {
    const code = [
      `DimensionElementInsert('${REGION}', '', 'Oceania', 'N');`,
      `AttrPutS('OC', '${REGION}', 'Oceania', 'Code');`,
    ].join("\n");
    const refused = await h.call("tm1_upsert_process", {
      processName: REFUSED_PROC,
      prolog: code,
    });
    expect(refused.isError).toBe(true);
    expect(refused.json.issues).toMatchObject([
      { kind: "uncommittedElement", name: "Oceania", dimension: REGION },
    ]);

    const run = await runUnchecked(code);
    expect(run.json).toMatchObject({ processErrorStatus: "HasMinorErrors" });
    expect(JSON.stringify(run.json)).toMatch(/Oceania.*not found/);

    const direct = await runUnchecked(
      [
        `DimensionElementInsertDirect('${REGION}', '', 'Antarctica', 'N');`,
        `AttrPutS('AN', '${REGION}', 'Antarctica', 'Code');`,
      ].join("\n"),
    );
    expect(direct.json).toMatchObject({
      processErrorStatus: "CompletedSuccessfully",
    });
  });
});
