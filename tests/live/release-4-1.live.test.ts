// Live checks for the 4.1.0 ergonomics and payload-control changes: the
// hierarchyName default, countOnly, attribute values for all elements, batch
// attribute updates with type coercion, the missing-dimension hint, rules
// outline / lineRange / patch, delete_elements, and the response-size guard.
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

const DIM = `${SANDBOX}_R41_DIM`;
const MEAS = `${SANDBOX}_R41_MEAS`;
const CUBE = `${SANDBOX}_R41_CUBE`;
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
    for (const [tool, args] of [
      ["tm1_delete_cube", { cubeName: CUBE, confirm: CUBE }],
      ["tm1_delete_dimension", { dimensionName: DIM, confirm: DIM }],
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
    await h.ok("tm1_create_dimension", { dimensionName: DIM });
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
    await h.ok("tm1_create_dimension", { dimensionName: MEAS });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: MEAS,
      elements: ["Base", "Double", "Triple"].map((name) => ({
        name,
        type: "Numeric",
      })),
    });
    await h.ok("tm1_create_cube", { cubeName: CUBE, dimensions: [DIM, MEAS] });
  });

  afterAll(cleanup);

  it("get_hierarchy defaults the hierarchy and sizes it with countOnly", async () => {
    const r = await h.ok("tm1_get_hierarchy", {
      dimensionName: DIM,
      countOnly: true,
    });
    expect(r.json).toMatchObject({
      name: DIM,
      elements: [],
      total: 13,
      counts: {
        byType: { Numeric: 12, String: 0, Consolidated: 1 },
        byLevel: { "0": 12, "1": 1 },
        maxLevel: 1,
      },
    });
    const filtered = await h.ok("tm1_get_hierarchy", {
      dimensionName: DIM,
      countOnly: true,
      level: 0,
    });
    expect(filtered.json.total).toBe(12);
  });

  it("writes attribute values in one batch, coerced to the attribute type", async () => {
    await h.ok("tm1_create_element_attribute", {
      dimensionName: DIM,
      attributeName: "Weight",
      attributeType: "Numeric",
    });
    await h.ok("tm1_create_element_attribute", {
      dimensionName: DIM,
      attributeName: "Caption",
      attributeType: "String",
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
  });

  it("reads attribute values for all elements, paged", async () => {
    const p1 = await h.ok("tm1_get_element_attribute_values", {
      dimensionName: DIM,
      limit: 5,
    });
    expect(p1.json).toMatchObject({
      total: 13,
      count: 5,
      has_more: true,
      next_offset: 5,
    });
    const l00 = p1.json.items.find(
      (i: { elementName: string }) => i.elementName === "L00",
    );
    expect(l00.values).toMatchObject({ Weight: 12.5, Caption: "zero" });

    const narrowed = await h.ok("tm1_get_element_attribute_values", {
      dimensionName: DIM,
      attributeNames: ["Weight"],
      offset: 0,
      limit: 2,
    });
    expect(Object.keys(narrowed.json.items[0].values)).toEqual(["Weight"]);
  });

  it("names the missing dimension on a short coordinate", async () => {
    // A server with EnableSandboxDimension prepends `Sandboxes` to every cube
    // it creates — the dimension callers forget. Read the real order.
    const listed = await h.ok("tm1_list_cubes", { nameExact: CUBE });
    const actual = listed.json.items[0].dimensions as string[];
    const order = actual.join(", ");

    const short = await h.call("tm1_get_cell_value", {
      cubeName: CUBE,
      elements: ["L00"],
    });
    expect(short.json.code).toBe("VALIDATION_ERROR");
    expect(short.json.message).toContain("(by position):");
    expect(short.json.hint).toContain(`in this order: ${order}`);

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
    await h.ok("tm1_delete_element", {
      dimensionName: DIM,
      elementName: "Total",
      confirm: "Total",
    });
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
    const left = await h.ok("tm1_get_hierarchy", {
      dimensionName: DIM,
      countOnly: true,
    });
    expect(left.json.total).toBe(10);
  });
});

// The largest dimension on the dev box (160k elements) — read-only.
describe.skipIf(!LIVE_ENABLED)("live: response-size guard", () => {
  it("refuses an oversized page instead of truncating it", async () => {
    const h = await getHarness();
    const dims = await h.ok("tm1_list_dimensions", {
      includeElementCount: true,
      fetchAll: true,
    });
    const big = (
      dims.json.items as Array<{
        name: string;
        elementCounts?: Record<string, number>;
      }>
    ).find((d) => (d.elementCounts?.[d.name] ?? 0) >= 10000);
    if (!big) return; // nothing large enough on this server
    const r = await h.call("tm1_get_hierarchy", {
      dimensionName: big.name,
      topN: 10000,
    });
    expect(r.isError).toBe(true);
    expect(r.json.code).toBe("RESPONSE_TOO_LARGE");
    expect(r.json.hint).toContain("countOnly=true");
    const counted = await h.ok("tm1_get_hierarchy", {
      dimensionName: big.name,
      countOnly: true,
    });
    expect(counted.json.total).toBe(big.elementCounts![big.name]);
  });
});
