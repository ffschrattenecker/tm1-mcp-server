// Live check for tm1_write_cells address resolution (6.0.0). Pins the TM1
// behavior measured on 11.8.03500 that motivates it:
//   - a cellset write that leaves out a regular dimension lands on that
//     dimension's default member, with no error;
//   - a named sandbox is addressable through the Sandboxes coordinate only
//     once IncludeInSandboxDimension=true.
// And pins the server's answer: a missing regular dimension is refused, and a
// left-out Sandboxes is bound to Base even when another member (a sandbox that
// sorts before "Base") exists in the dimension.
//
// Needs EnableSandboxDimension=true; skips on servers whose new cubes carry no
// Sandboxes dimension. Every object is SANDBOX-prefixed and removed in afterAll
// (sweepSandbox in global-setup is the safety net, including TM1 sandboxes).
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  rawRequest,
  type LiveHarness,
} from "./harness.js";

const CUBE = `${SANDBOX}_WA_CUBE`;
const ROW = `${SANDBOX}_WA_ROW`;
const MEAS = `${SANDBOX}_WA_MEAS`;
// Sorts before "Base", so "first member" and "Base" disagree.
const SB = `AA_${SANDBOX}_WA_SB`;

describe.skipIf(!LIVE_ENABLED)("live: write_cells address resolution", () => {
  let h: LiveHarness;
  let sandboxed = false;

  const read = async (sandbox: string, row: string, meas: string) => {
    const r = await h.ok("tm1_execute_mdx", {
      mdx: `SELECT {[${MEAS}].[${meas}]} ON 0 FROM [${CUBE}] WHERE ([Sandboxes].[${sandbox}], [${ROW}].[${row}])`,
    });
    return r.json.items[0].value as number | null;
  };

  const cleanup = async () => {
    try {
      await rawRequest(h, "DELETE", `/api/v1/Sandboxes('${SB}')`);
    } catch {
      /* already gone */
    }
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
      elements: [
        { name: "R1", type: "Numeric" },
        { name: "R2", type: "Numeric" },
      ],
    });
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: MEAS,
      elements: [
        { name: "Amount", type: "Numeric" },
        { name: "Other", type: "Numeric" },
      ],
    });
    await h.ok("tm1_create_cube", { cubeName: CUBE, dimensions: [ROW, MEAS] });
    const dims = await h.client.cubes.getDimensionNames(CUBE);
    sandboxed = dims[0] === "Sandboxes";
    if (!sandboxed) return;
    await rawRequest(h, "POST", "/api/v1/Sandboxes", {
      Name: SB,
      IncludeInSandboxDimension: true,
    });
  });

  afterAll(cleanup);

  it("refuses a write that leaves out a regular dimension", async (ctx) => {
    if (!sandboxed) ctx.skip();
    await h.ok("tm1_write_cells", {
      cubeName: CUBE,
      confirm: CUBE,
      dimensions: ["Sandboxes", ROW, MEAS],
      cells: [{ elements: ["Base", "R2", "Amount"], value: 20 }],
    });
    const r = await h.call("tm1_write_cells", {
      cubeName: CUBE,
      confirm: CUBE,
      dimensions: ["Sandboxes", ROW],
      cells: [{ elements: ["Base", "R2"], value: 5 }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(new RegExp(`missing: ${MEAS}`));
    expect(await read("Base", "R2", "Amount")).toBe(20);
  });

  it("binds a left-out Sandboxes to Base, not to the first member", async (ctx) => {
    if (!sandboxed) ctx.skip();
    const r = await h.ok("tm1_write_cells", {
      cubeName: CUBE,
      confirm: CUBE,
      dimensions: [MEAS, ROW],
      cells: [{ elements: ["Amount", "R1"], value: 10 }],
    });
    expect(r.json.sandboxDefaulted).toBe("Base");
    expect(await read("Base", "R1", "Amount")).toBe(10);
  });

  it("writes into a named sandbox only, when addressed explicitly", async (ctx) => {
    if (!sandboxed) ctx.skip();
    await h.ok("tm1_write_cells", {
      cubeName: CUBE,
      confirm: CUBE,
      dimensions: ["Sandboxes", ROW, MEAS],
      cells: [{ elements: [SB, "R1", "Amount"], value: 111 }],
    });
    expect(await read(SB, "R1", "Amount")).toBe(111);
    expect(await read("Base", "R1", "Amount")).toBe(10);
  });

  it("check_writable_coords resolves the same address as the write", async (ctx) => {
    if (!sandboxed) ctx.skip();
    const r = await h.ok("tm1_check_writable_coords", {
      cubeName: CUBE,
      dimensions: [MEAS, ROW],
      coords: ["Amount", "R1"],
    });
    expect(r.json).toMatchObject({ writable: true, sandboxDefaulted: "Base" });
    expect(r.json.coords.map((c: { element: string }) => c.element)).toEqual([
      "Base",
      "R1",
      "Amount",
    ]);
  });
});
