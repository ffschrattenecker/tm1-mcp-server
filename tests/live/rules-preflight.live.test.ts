// Live check for the tm1_set_cube_rules preflight. Pins the TM1 behavior that
// motivates it: the Rules PATCH stores syntactically broken text without an
// error (verified on 11.8.03500), so CheckRules is the only gate. And the gap
// the preflight closes on top of it: CheckRules accepts a DB() with the wrong
// element count, a missing cube or a missing literal element, and the rule
// then reads 0 without an error.
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
    await createDimension(h, ROW, ["R1", "Spare"]);
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

  it("refuses a DB() naming a missing cube or a missing element, which CheckRules accepts", async () => {
    const gone = `SKIPCHECK;\n['Double'] = N: DB('${SANDBOX}_RP_GONE', !${ROW}, 'Amount') * 2;\nFEEDERS;\n`;
    const missing = dbRule(`'R9'`, "'Amount'");
    for (const [rules, pattern] of [
      [gone, /names a cube that does not exist/],
      [missing, new RegExp(`element 'R9', which is not in dimension '${ROW}'`)],
    ] as const) {
      const check = await h.ok("tm1_check_cube_rule", {
        cubeName: CUBE,
        rules,
      });
      // The one error is ours: CheckRules itself found nothing.
      expect(check.json).toMatchObject({ ok: false, errorCount: 1 });
      expect(check.json.errors[0]).toMatchObject({ lineNumber: 2 });
      expect(check.json.errors[0].message).toMatch(pattern);
    }

    const refused = await h.call("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      rules: missing,
    });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: "VALIDATION_ERROR" });

    // Stored anyway, both rules read nothing, without an error.
    const double = () => cellValue(h, CUBE, [ROW, MEAS], ["R1", "Double"]);
    for (const rules of [gone, missing]) {
      await h.ok("tm1_set_cube_rules", {
        cubeName: CUBE,
        confirm: CUBE,
        rules,
        preflight: false,
      });
      expect(await double()).toBeNull();
    }

    // An alias resolves in DB() and passes.
    await h.ok("tm1_rest_write", {
      method: "POST",
      path: `Dimensions('${ROW}')/Hierarchies('${ROW}')/ElementAttributes`,
      body: { Name: "Code", Type: "Alias" },
    });
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: ROW,
      elementName: "R1",
      attributeName: "Code",
      value: "First",
    });
    const alias = await h.ok("tm1_check_cube_rule", {
      cubeName: CUBE,
      rules: dbRule(`'First'`, "'Amount'"),
    });
    expect(alias.json).toMatchObject({ ok: true });
  });

  it("an element deleted under a stored rule breaks it silently; check_all_cube_rules finds it", async () => {
    const rules =
      "SKIPCHECK;\n['Double'] = N: ['Amount'] * 2 + ['Spare', 'Amount'];\nFEEDERS;\n";
    await h.ok("tm1_set_cube_rules", { cubeName: CUBE, confirm: CUBE, rules });
    await h.ok("tm1_write_cells", {
      cubeName: CUBE,
      confirm: CUBE,
      dimensions: [ROW, MEAS],
      cells: [{ elements: ["R1", "Amount"], value: 5 }],
    });
    const double = () => cellValue(h, CUBE, [ROW, MEAS], ["R1", "Double"]);
    expect(await double()).toBe(10);

    // TM1 deletes the element, keeps the rule text, and the rule reads nothing.
    await h.ok("tm1_delete_elements", {
      dimensionName: ROW,
      elementNames: ["Spare"],
      confirm: ROW,
    });
    const back = await h.ok("tm1_get_cube_rules", { cubeName: CUBE });
    expect(String(back.json.rulesText).replace(/\r\n/g, "\n")).toBe(rules);
    expect(await double()).toBeNull();

    const sweep = await h.ok("tm1_check_all_cube_rules", {});
    const mine = sweep.json.cubes.find(
      (c: { cube: string }) => c.cube === CUBE,
    );
    expect(mine).toMatchObject({ errors: [{ lineNumber: 2 }] });
    expect(mine.errors[0].message).toMatch(/Element not found/);
  });
});

// Outline, line slices and patches on a 60-line rule text: the path an editor
// takes on a large rule set. The server stores CRLF; the tools serve LF.
describe.skipIf(!LIVE_ENABLED)(
  "live: rules outline, slices and patches",
  () => {
    let h: LiveHarness;
    const OUT_DIM = `${SANDBOX}_RP_OUT_DIM`;
    const OUT_MEAS = `${SANDBOX}_RP_OUT_MEAS`;
    const OUT_CUBE = `${SANDBOX}_RP_OUT_CUBE`;
    const LEAVES = Array.from(
      { length: 12 },
      (_, i) => `L${String(i).padStart(2, "0")}`,
    );

    // 60+ lines with comment-block headers, so outline/lineRange have something
    // to navigate.
    const RULES = [
      "# Outline sandbox rules",
      "SKIPCHECK;",
      "",
      "# 1) Doubles",
      ...LEAVES.map(
        (l) =>
          `['${OUT_MEAS}':'Double','${OUT_DIM}':'${l}'] = N: ['${OUT_MEAS}':'Base'] * 2;`,
      ),
      "",
      "# 2) Triples",
      ...LEAVES.map(
        (l) =>
          `['${OUT_MEAS}':'Triple','${OUT_DIM}':'${l}'] = N: ['${OUT_MEAS}':'Base'] * 3;`,
      ),
      "",
      "FEEDERS;",
      "# feed both",
      `['${OUT_MEAS}':'Base'] => ['${OUT_MEAS}':'Double'];`,
      `['${OUT_MEAS}':'Base'] => ['${OUT_MEAS}':'Triple'];`,
    ].join("\r\n");

    const cleanup = async () => {
      await dropIfExists(h, seg("Cubes", OUT_CUBE));
      await dropIfExists(h, seg("Dimensions", OUT_DIM));
      await dropIfExists(h, seg("Dimensions", OUT_MEAS));
    };

    beforeAll(async () => {
      h = await getHarness();
      await cleanup();
      await createDimension(h, OUT_DIM, LEAVES);
      await createDimension(h, OUT_MEAS, ["Base", "Double", "Triple"]);
      await createCube(h, OUT_CUBE, [OUT_DIM, OUT_MEAS]);
    });

    afterAll(cleanup);

    it("sets, outlines, slices and patches rules", async () => {
      await h.ok("tm1_set_cube_rules", {
        cubeName: OUT_CUBE,
        rules: RULES,
        confirm: OUT_CUBE,
      });
      const outline = await h.ok("tm1_get_cube_rules", {
        cubeName: OUT_CUBE,
        outline: true,
      });
      expect(outline.json.rulesText).toBeUndefined();
      const marks = outline.json.outline.map((o: { text: string }) => o.text);
      expect(marks).toEqual([
        "# Outline sandbox rules",
        "SKIPCHECK;",
        "# 1) Doubles",
        "# 2) Triples",
        "FEEDERS;",
        "# feed both",
      ]);
      const triples = outline.json.outline.find(
        (o: { text: string }) => o.text === "# 2) Triples",
      ).line as number;
      const slice = await h.ok("tm1_get_cube_rules", {
        cubeName: OUT_CUBE,
        lineRange: [triples, triples + 1],
      });
      expect(slice.json.rulesText).toBe(
        `# 2) Triples\n['${OUT_MEAS}':'Triple','${OUT_DIM}':'L00'] = N: ['${OUT_MEAS}':'Base'] * 3;`,
      );

      // Patch the slice back in, quoted as served (LF against CRLF storage).
      await h.ok("tm1_set_cube_rules", {
        cubeName: OUT_CUBE,
        confirm: OUT_CUBE,
        edits: [
          {
            find: slice.json.rulesText,
            replace: `# 2) Triples\n['${OUT_MEAS}':'Triple','${OUT_DIM}':'L00'] = N: ['${OUT_MEAS}':'Base'] * 30;`,
          },
        ],
      });
      const after = await h.ok("tm1_get_cube_rules", {
        cubeName: OUT_CUBE,
        lineRange: [triples + 1, triples + 1],
      });
      expect(after.json.rulesText).toContain("* 30;");

      const ambiguous = await h.call("tm1_set_cube_rules", {
        cubeName: OUT_CUBE,
        confirm: OUT_CUBE,
        edits: [{ find: "* 3;", replace: "* 4;" }],
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.json.message).toMatch(/matches 11 times/);
    });
  },
);
