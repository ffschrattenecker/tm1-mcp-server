// Live checks for the 4.1.0 ergonomics changes: batch attribute updates with
// type coercion, the missing-dimension hint, rules outline / lineRange /
// patch, and delete_elements.
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
  restGet,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const DIM = `${SANDBOX}_R41_DIM`;
const MEAS = `${SANDBOX}_R41_MEAS`;
const CUBE = `${SANDBOX}_R41_CUBE`;
const HIER = `${seg("Dimensions", DIM)}/${seg("Hierarchies", DIM)}`;
const LEAVES = Array.from(
  { length: 12 },
  (_, i) => `L${String(i).padStart(2, "0")}`,
);

// 60+ lines with comment-block headers, so outline/lineRange have something
// to navigate.
const RULES = [
  "# R41 sandbox rules",
  "SKIPCHECK;",
  "",
  "# 1) Doubles",
  ...LEAVES.map(
    (l) => `['${MEAS}':'Double','${DIM}':'${l}'] = N: ['${MEAS}':'Base'] * 2;`,
  ),
  "",
  "# 2) Triples",
  ...LEAVES.map(
    (l) => `['${MEAS}':'Triple','${DIM}':'${l}'] = N: ['${MEAS}':'Base'] * 3;`,
  ),
  "",
  "FEEDERS;",
  "# feed both",
  `['${MEAS}':'Base'] => ['${MEAS}':'Double'];`,
  `['${MEAS}':'Base'] => ['${MEAS}':'Triple'];`,
].join("\r\n");

describe.skipIf(!LIVE_ENABLED)("live: 4.1.0 ergonomics", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    await dropIfExists(h, seg("Cubes", CUBE));
    await dropIfExists(h, seg("Dimensions", DIM));
    await dropIfExists(h, seg("Dimensions", MEAS));
  };

  const elementCount = async () => {
    const r = await h.ok("tm1_rest_read", { path: `${HIER}/Elements/$count` });
    return Number(r.json.text ?? r.json.data);
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, DIM);
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: DIM,
      elements: [
        ...LEAVES.map((name) => ({ name, type: "Numeric" })),
        {
          name: "Total",
          type: "Consolidated",
          components: LEAVES.map((name) => ({ name, weight: 1 })),
        },
      ],
    });
    await createDimension(h, MEAS);
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: MEAS,
      elements: ["Base", "Double", "Triple"].map((name) => ({
        name,
        type: "Numeric",
      })),
    });
    await createCube(h, CUBE, [DIM, MEAS]);
  });

  afterAll(cleanup);

  it("writes attribute values in one batch, coerced to the attribute type", async () => {
    await restWrite(h, "POST", `${HIER}/ElementAttributes`, {
      Name: "Weight",
      Type: "Numeric",
    });
    await restWrite(h, "POST", `${HIER}/ElementAttributes`, {
      Name: "Caption",
      Type: "String",
    });
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: DIM,
      updates: [
        { elementName: "L00", attributeName: "Weight", value: "12.5" },
        { elementName: "L01", attributeName: "Weight", value: 3 },
        { elementName: "L00", attributeName: "Caption", value: "zero" },
      ],
    });
    const bad = await h.call("tm1_update_element_attribute_value", {
      dimensionName: DIM,
      elementName: "L02",
      attributeName: "Weight",
      value: "heavy",
    });
    expect(bad.isError).toBe(true);
    expect(bad.json.code).toBe("VALIDATION_ERROR");

    const l00 = await restGet<{ Attributes: Record<string, unknown> }>(
      h,
      `${HIER}/Elements('L00')?$select=Name,Attributes`,
    );
    expect(l00.Attributes).toMatchObject({ Weight: 12.5, Caption: "zero" });
  });

  it("names the missing dimension on a short coordinate", async () => {
    // A server with EnableSandboxDimension prepends `Sandboxes` to every cube
    // it creates — the dimension callers forget. Read the real order.
    const cube = await restGet<{ Dimensions: Array<{ Name: string }> }>(
      h,
      `${seg("Cubes", CUBE)}?$select=Name&$expand=Dimensions($select=Name)`,
    );
    const actual = cube.Dimensions.map((d) => d.Name);
    const order = actual.join(", ");

    // A tuple shorter than its own dimension list.
    const r = await h.call("tm1_write_cells", {
      cubeName: CUBE,
      dimensions: actual,
      cells: [{ elements: ["Base"], value: 1 }],
      confirm: CUBE,
    });
    expect(r.isError).toBe(true);
    expect(r.json.message).toContain("(by position):");
    expect(r.json.hint).toContain(`in this order: ${order}`);
  });

  it("sets, outlines, slices and patches rules", async () => {
    await h.ok("tm1_set_cube_rules", {
      cubeName: CUBE,
      rules: RULES,
      confirm: CUBE,
    });
    const outline = await h.ok("tm1_get_cube_rules", {
      cubeName: CUBE,
      outline: true,
    });
    expect(outline.json.rulesText).toBeUndefined();
    const marks = outline.json.outline.map((o: { text: string }) => o.text);
    expect(marks).toEqual([
      "# R41 sandbox rules",
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
      cubeName: CUBE,
      lineRange: [triples, triples + 1],
    });
    expect(slice.json.rulesText).toBe(
      `# 2) Triples\n['${MEAS}':'Triple','${DIM}':'L00'] = N: ['${MEAS}':'Base'] * 3;`,
    );

    // Patch the slice back in, quoted as served (LF against CRLF storage).
    await h.ok("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      edits: [
        {
          find: slice.json.rulesText,
          replace: `# 2) Triples\n['${MEAS}':'Triple','${DIM}':'L00'] = N: ['${MEAS}':'Base'] * 30;`,
        },
      ],
    });
    const after = await h.ok("tm1_get_cube_rules", {
      cubeName: CUBE,
      lineRange: [triples + 1, triples + 1],
    });
    expect(after.json.rulesText).toContain("* 30;");

    const ambiguous = await h.call("tm1_set_cube_rules", {
      cubeName: CUBE,
      confirm: CUBE,
      edits: [{ find: "* 3;", replace: "* 4;" }],
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.json.message).toMatch(/matches 11 times/);
  });

  it("delete_elements removes many and reports the missing one", async () => {
    // Detach the leaves first so the consolidation does not hold them.
    await restWrite(h, "DELETE", `${HIER}/Elements('Total')`);
    const r = await h.ok("tm1_delete_elements", {
      dimensionName: DIM,
      elementNames: ["L10", "L11", "NOPE"],
      confirm: DIM,
    });
    expect(r.json).toMatchObject({
      success: false,
      deleted: 2,
      failed: 1,
      failures: [{ elementName: "NOPE" }],
    });
    expect(await elementCount()).toBe(10);
  });
});
