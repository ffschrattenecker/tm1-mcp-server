// Live lifecycle: CUBE + CELL/RULES domain end-to-end against a real TM1
// server. Builds two sandbox dimensions (one element carries a single quote to
// exercise OData literal escaping), a cube over them, then exercises the cell
// and rules tool surface and tears everything down idempotently. Rule preflight
// and the rule outline/patch paths live in rules-preflight.live.test.ts.
//
// Opt-in: skips unless TM1_BASE_URL + TM1_USER are set. Every object is
// prefixed `${SANDBOX}_CUBE` so a stray run can never touch real model data.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cellValue,
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  names,
  restGet,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const D1 = `${SANDBOX}_CUBE_D1`;
const D2 = `${SANDBOX}_CUBE_D2`;
const C1 = `${SANDBOX}_CUBE_C1`;

// D1 elements: a plain leaf and a leaf whose name contains a single quote, so
// every coordinate lookup (write_cells, MDX, sample) drives the
// OData single-quote escaping path ('' doubling) at least once.
const D1_PLAIN = "E1";
const D1_QUOTE = "O'Brien"; // single quote → tests OData escaping
const D2_A = "A1";
const D2_B = "A2";

/** Up to `top` non-control cube names. */
const cubeNames = async (h: LiveHarness, top: number): Promise<string[]> =>
  (
    await restGet<Array<{ Name: string }>>(
      h,
      `Cubes?$select=Name&$filter=not startswith(Name,'}')&$top=${top}`,
    )
  ).map((c) => c.Name);

describe.skipIf(!LIVE_ENABLED)("live: cube + cell/rules lifecycle", () => {
  let h: LiveHarness;

  beforeAll(async () => {
    h = await getHarness();

    // Clean any leftovers from a crashed prior run (idempotent).
    await cleanup();

    // Dimensions first — a cube cannot be created without them.
    await createDimension(h, D1, [D1_PLAIN, D1_QUOTE]);
    await createDimension(h, D2, [D2_A, D2_B]);

    // Cube over the two dimensions. Order matters for perf, not for the test.
    await createCube(h, C1, [D1, D2]);
  });

  // Idempotent teardown. Cube must go before its dimensions (dim delete fails
  // while referenced by a cube).
  const cleanup = async () => {
    await dropIfExists(h, seg("Cubes", C1));
    await dropIfExists(h, seg("Dimensions", D1));
    await dropIfExists(h, seg("Dimensions", D2));
  };

  afterAll(async () => {
    await cleanup();
  });

  it("the cube exists over the two sandbox dimensions", async () => {
    expect(await names(h, "Cubes", SANDBOX)).toContain(C1);
  });

  it("write_cells round-trips a value (plain coord)", async () => {
    await h.ok("tm1_write_cells", {
      cubeName: C1,
      dimensions: [D1, D2],
      cells: [{ elements: [D1_PLAIN, D2_A], value: 42 }],
      confirm: C1,
    });
    expect(await cellValue(h, C1, [D1, D2], [D1_PLAIN, D2_A])).toBe(42);
  });

  it("write_cells round-trips through the single-quote element (OData escaping)", async () => {
    await h.ok("tm1_write_cells", {
      cubeName: C1,
      dimensions: [D1, D2],
      cells: [{ elements: [D1_QUOTE, D2_B], value: 7 }],
      confirm: C1,
    });
    expect(await cellValue(h, C1, [D1, D2], [D1_QUOTE, D2_B])).toBe(7);
  });

  it("write_cells names the missing dimension on a short coordinate", async () => {
    // Read the real storage order: a server with sandboxing on prepends
    // `Sandboxes` to every cube, which is the dimension callers forget.
    const cube = await restGet<{ Dimensions: Array<{ Name: string }> }>(
      h,
      `${seg("Cubes", C1)}?$select=Name&$expand=Dimensions($select=Name)`,
    );
    const actual = cube.Dimensions.map((d) => d.Name);
    // One element for a cube with two or more dimensions.
    const r = await h.call("tm1_write_cells", {
      cubeName: C1,
      dimensions: actual,
      cells: [{ elements: [D1_PLAIN], value: 1 }],
      confirm: C1,
    });
    expect(r.isError).toBe(true);
    expect(r.json.message).toContain("(by position):");
    expect(r.json.hint).toContain(`in this order: ${actual.join(", ")}`);
  });

  it("check_writable_coords reports leaf coords as writable", async () => {
    const r = await h.ok("tm1_check_writable_coords", {
      cubeName: C1,
      coords: [D1_PLAIN, D2_A],
    });
    expect(r.json.writable).toBe(true);
    expect(r.json.allElementsExist).toBe(true);
    expect(r.json.allElementsNLevel).toBe(true);
  });

  it("sample_cells returns the populated cells", async () => {
    const r = await h.ok("tm1_sample_cells", { cubeName: C1, maxCells: 10 });
    expect(Array.isArray(r.json.cells)).toBe(true);
    // We wrote two non-zero leaf cells above.
    expect(r.json.cells.length).toBeGreaterThanOrEqual(1);
  });

  it("sample_cells reports truncated=false when the result is exactly the page size", async () => {
    const cubes = await cubeNames(h, 50);

    // Find a cube with FEWER populated cells than the probe limit — that is
    // the case the old `cells.length >= maxCells` comparison could not tell
    // apart from "more exist".
    let found: { cube: string; n: number } | undefined;
    for (const cube of cubes) {
      const r = await h.call("tm1_sample_cells", {
        cubeName: cube,
        maxCells: 20,
      });
      if (r.isError) continue;
      const n: number = r.json?.count ?? 0;
      if (n > 0 && n < 20) {
        found = { cube, n };
        break;
      }
    }
    if (!found) {
      // Nothing on this server fits the shape — say so instead of asserting
      // something vacuous.
      console.warn(
        "sample_cells: no cube with 0 < populated cells < 20; not asserted",
      );
      return;
    }

    // Ask for exactly as many cells as exist: must NOT report truncation.
    const exact = await h.ok("tm1_sample_cells", {
      cubeName: found.cube,
      maxCells: found.n,
    });
    expect(exact.json.count).toBe(found.n);
    expect(exact.json.truncated).toBe(false);

    // Ask for one fewer: genuinely truncated.
    if (found.n > 1) {
      const short = await h.ok("tm1_sample_cells", {
        cubeName: found.cube,
        maxCells: found.n - 1,
      });
      expect(short.json.count).toBe(found.n - 1);
      expect(short.json.truncated).toBe(true);
    }
  });

  it("execute_mdx over the cube returns a cellset", async () => {
    const mdx =
      `SELECT NON EMPTY {[${D1}].[${D1}].Members} ON COLUMNS, ` +
      `NON EMPTY {[${D2}].[${D2}].Members} ON ROWS ` +
      `FROM [${C1}]`;
    const r = await h.ok("tm1_execute_mdx", { mdx });
    expect(r.json).toMatchObject({
      count: expect.any(Number),
      items: expect.any(Array),
    });
    expect(r.json.items.length).toBeGreaterThan(0);
  });

  it("get_cube_stats returns metrics on v11, a clean 'absent' on v12", async () => {
    // v12 (Planning Analytics Engine 12.5.9) ships no }Stats* control cubes,
    // so there are no metrics to return there — only an honest verdict.
    const r = await h.ok("tm1_get_cube_stats", { cubeName: C1 });
    expect(r.json.count).toBe(1);
    expect(r.json.items[0].cubeName).toBe(C1);
    if (h.client.version === 12) {
      expect(r.json.statsUnavailable?.reason).toBe("absent");
      expect(r.json.items[0].error).toBe(r.json.statsUnavailable.message);
    } else {
      // The server-wide verdict must stay clear on v11: }StatsByCube exists
      // here, so "unavailable" would be a false claim about the whole server.
      expect(r.json.statsUnavailable).toBeUndefined();
      // The cube itself may still be unknown to }StatsByCube. TM1 lists a cube
      // there only after a performance-monitor cycle has sampled it, and this
      // cube was created seconds ago — measured live: the MDX answers "member
      // not found" for it while the same call returns metrics for cubes that
      // have been on the server a while. Both outcomes are correct behaviour;
      // what must hold is that a per-cube miss is reported per cube, and names
      // the cube rather than being swallowed or generalized.
      const { error } = r.json.items[0];
      if (error !== undefined) {
        expect(error).toContain(C1);
      } else {
        expect(r.json.items[0]).toMatchObject({ cubeName: C1 });
      }
    }
  });

  it("set_cube_rules then get_cube_rules reads the rule back", async () => {
    const rules = `SKIPCHECK;\n['${D1_PLAIN}'] = N: 1;\nFEEDERS;`;
    await h.ok("tm1_set_cube_rules", { cubeName: C1, rules, confirm: C1 });
    const r = await h.ok("tm1_get_cube_rules", { cubeName: C1 });
    const text = typeof r.json === "string" ? r.json : (r.json.rules ?? r.text);
    expect(String(text)).toContain("SKIPCHECK");
    expect(String(text)).toContain(D1_PLAIN);
  });

  it("get_all_cube_rules includes the sandbox cube (summary mode)", async () => {
    const r = await h.ok("tm1_get_all_cube_rules", {
      onlyWithRules: true,
      summary: true,
    });
    const cubes = r.json.cubes as Array<{ cubeName: string }>;
    expect(cubes.some((c) => c.cubeName === C1)).toBe(true);
  });

  it("search_rules finds the SKIPCHECK line in the sandbox cube", async () => {
    const r = await h.ok("tm1_search_rules", {
      pattern: "SKIPCHECK",
      cubes: [C1],
    });
    expect(r.json.matchCount).toBeGreaterThanOrEqual(1);
    const items = r.json.items as Array<{ cube: string }>;
    expect(items.some((m) => m.cube === C1)).toBe(true);
  });

  it("clear_cube wipes the cube (confirm required)", async () => {
    const r = await h.call("tm1_clear_cube", {
      cubeName: C1,
      confirm: C1,
    });
    expect(r.isError).toBeFalsy();
  });
});
