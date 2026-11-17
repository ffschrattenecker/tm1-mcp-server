// Live check for the sandbox tools (tm1_create_sandbox, tm1_list_sandboxes,
// tm1_compare_sandbox, tm1_discard_sandbox, tm1_publish_sandbox,
// tm1_delete_sandbox) and the `sandbox` argument of tm1_write_cells and
// tm1_execute_mdx. It records the REST contracts those calls put on the wire
// and smoke-tests the feature against a real TM1 server, on two connections:
//   - the default readwrite connection: a full write, compare, discard and
//     publish cycle on one managed sandbox;
//   - a sandbox-mode connection (TM1_MODE=sandbox, prefix ZZ_MCP_LIVE_SB): the
//     refusals that keep it inside its own sandboxes, and its managed sandbox
//     lifecycle.
// Skips the whole file on a server with DisableSandboxing=T, whose sandbox
// tools refuse every call. The cube may or may not carry the Sandboxes
// dimension (EnableSandboxDimension); the flow works either way.
//
// Every object is SANDBOX-prefixed. The sandboxes this file creates also carry
// the sandbox-mode prefix, so global-setup's sweep removes them if a run dies.
// afterAll deletes the sandbox, then the cube and its dimensions.
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  rawRequest,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const CUBE = `${SANDBOX}_SB_CUBE`;
const ROW = `${SANDBOX}_SB_ROW`;
const MEAS = `${SANDBOX}_SB_MEAS`;
const CONTROL = "}ClientGroups";
// Prefix of the sandbox-mode connection. It carries the SANDBOX marker, so the
// sandboxes this file manages are swept like everything else it creates.
const PREFIX = `${SANDBOX}_SB`;
const MANAGED = `${PREFIX}1`;
// Starts with SANDBOX but not with PREFIX, so the sandbox-mode connection does
// not manage it. Only named in refusals; never created.
const FOREIGN = `${SANDBOX}_OTHER`;

// The one cell this file writes: row R1, measure Amount.
const MDX = `SELECT {([${ROW}].[${ROW}].[R1],[${MEAS}].[${MEAS}].[Amount])} ON 0 FROM [${CUBE}]`;

type Listed = { name: string; managed: boolean };

const writeCell = (value: number, sandbox?: string) => ({
  cubeName: CUBE,
  confirm: CUBE,
  dimensions: [ROW, MEAS],
  cells: [{ elements: ["R1", "Amount"], value }],
  sandbox,
});

/** The cell's value in base data, or in `sandbox` when one is given. */
async function cellAt(h: LiveHarness, sandbox?: string): Promise<unknown> {
  const r = await h.ok("tm1_execute_mdx", { mdx: MDX, sandbox });
  return r.json.items[0]?.value ?? null;
}

async function listSandboxes(h: LiveHarness): Promise<Listed[]> {
  return (await h.ok("tm1_list_sandboxes", { limit: 0 })).json.items;
}

/** DELETE a sandbox, ignoring one that is already gone. */
async function dropSandbox(h: LiveHarness, name: string): Promise<void> {
  try {
    await rawRequest(h, "DELETE", `/api/v1/${seg("Sandboxes", name)}`);
  } catch {
    /* already gone */
  }
}

/** False when the server answers the sandbox tools with DisableSandboxing=T. */
async function sandboxingOn(h: LiveHarness): Promise<boolean> {
  const r = await h.call("tm1_list_sandboxes", { limit: 0 });
  return !(r.isError && /DisableSandboxing/.test(r.text ?? ""));
}

describe.skipIf(!LIVE_ENABLED)("live: sandboxes", () => {
  let h: LiveHarness;
  let sb: LiveHarness;
  let sandboxing = false;
  let hasSandboxDim = false;

  const cleanup = async () => {
    await dropSandbox(h, MANAGED);
    await dropIfExists(h, seg("Cubes", CUBE));
    await dropIfExists(h, seg("Dimensions", ROW));
    await dropIfExists(h, seg("Dimensions", MEAS));
  };

  beforeAll(async () => {
    h = await getHarness();
    sb = await getHarness({ mode: "sandbox", sandboxPrefix: PREFIX });
    sandboxing = await sandboxingOn(h);
    await cleanup();
    if (!sandboxing) return;
    await createDimension(h, ROW, ["R1", "R2"]);
    await createDimension(h, MEAS, ["Amount", "Other"]);
    await createCube(h, CUBE, [ROW, MEAS]);
    hasSandboxDim = (await h.client.cubes.getDimensionNames(CUBE)).includes(
      "Sandboxes",
    );
  });

  afterAll(async () => {
    await cleanup();
    await sb.client.disconnect();
  });

  describe("readwrite connection", () => {
    it("writes the base value", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const r = await h.ok("tm1_write_cells", writeCell(10));
      expect(r.json.verified.mismatches).toEqual([]);
      expect(await cellAt(h)).toBe(10);
    });

    it("creates the managed sandbox and lists it", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const created = await h.ok("tm1_create_sandbox", {
        sandboxName: MANAGED,
      });
      expect(created.json.success).toBe(true);
      const row = (await listSandboxes(h)).find((s) => s.name === MANAGED);
      expect(row).toBeDefined();
      // `managed` follows THIS connection's prefix (TM1_SANDBOX_PREFIX, default
      // "mcp-"), not the sandbox-mode prefix; the sandbox-mode block asserts true.
      expect(row?.managed).toBe(
        MANAGED.toLowerCase().startsWith(h.client.sandboxPrefix.toLowerCase()),
      );
    });

    it("writes into the sandbox and leaves base data alone", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const r = await h.ok("tm1_write_cells", writeCell(25, MANAGED));
      expect(r.json.verified.mismatches).toEqual([]);
      if (hasSandboxDim) expect(r.json.sandboxDefaulted).toBe(MANAGED);
      expect(await cellAt(h, MANAGED)).toBe(25);
      expect(await cellAt(h)).toBe(10);
    });

    it("compare reports the changed cell, base 10 to sandbox 25", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const r = await h.ok("tm1_compare_sandbox", {
        sandboxName: MANAGED,
        mdx: MDX,
      });
      expect(r.json).toMatchObject({
        sandbox: MANAGED,
        differences: 1,
        truncated: false,
      });
      expect(r.json.cells[0]).toMatchObject({
        base: 10,
        sandbox: 25,
        change: 15,
      });
    });

    it("discard empties the sandbox and keeps it", async (ctx) => {
      if (!sandboxing) ctx.skip();
      await h.ok("tm1_discard_sandbox", {
        sandboxName: MANAGED,
        confirm: MANAGED,
      });
      const r = await h.ok("tm1_compare_sandbox", {
        sandboxName: MANAGED,
        mdx: MDX,
      });
      expect(r.json.differences).toBe(0);
      expect(await cellAt(h, MANAGED)).toBe(10);
      expect((await listSandboxes(h)).some((s) => s.name === MANAGED)).toBe(
        true,
      );
    });

    it("publish merges the sandbox into base data", async (ctx) => {
      if (!sandboxing) ctx.skip();
      await h.ok("tm1_write_cells", writeCell(30, MANAGED));
      await h.ok("tm1_publish_sandbox", {
        sandboxName: MANAGED,
        confirm: MANAGED,
      });
      expect(await cellAt(h)).toBe(30);
      // TM1 may keep or drop the sandbox after a publish. Both the next block
      // and afterAll delete it first, so either outcome is fine.
    });
  });

  describe("sandbox-mode connection", () => {
    beforeAll(async () => {
      if (sandboxing) await dropSandbox(sb, MANAGED);
    });

    it("refuses a write that names no sandbox", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const r = await sb.call("tm1_write_cells", writeCell(99));
      expect(r.isError).toBe(true);
      expect(r.json.code).toBe("PERMISSION_DENIED");
      expect(await cellAt(h)).toBe(30);
    });

    it("refuses a sandbox without the prefix, in every sandbox tool", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const results = [
        await sb.call("tm1_write_cells", writeCell(99, FOREIGN)),
        await sb.call("tm1_create_sandbox", { sandboxName: FOREIGN }),
        await sb.call("tm1_discard_sandbox", {
          sandboxName: FOREIGN,
          confirm: FOREIGN,
        }),
        await sb.call("tm1_delete_sandbox", {
          sandboxName: FOREIGN,
          confirm: FOREIGN,
        }),
      ];
      for (const r of results) {
        expect(r.isError).toBe(true);
        expect(r.json.code).toBe("PERMISSION_DENIED");
      }
    });

    it("refuses a write into a control cube, even into its managed sandbox", async (ctx) => {
      if (!sandboxing) ctx.skip();
      const r = await sb.call("tm1_write_cells", {
        ...writeCell(1, MANAGED),
        cubeName: CONTROL,
        confirm: CONTROL,
      });
      expect(r.isError).toBe(true);
      expect(r.json.code).toBe("PERMISSION_DENIED");
    });

    it("does not register tm1_publish_sandbox", async (ctx) => {
      if (!sandboxing) ctx.skip();
      expect(sb.has("tm1_publish_sandbox")).toBe(false);
      // An unregistered tool never reaches its handler, so this cannot publish.
      await expect(
        sb.call("tm1_publish_sandbox", {
          sandboxName: MANAGED,
          confirm: MANAGED,
        }),
      ).rejects.toThrow(/not registered/);
    });

    it("creates, writes, reads and deletes a managed sandbox", async (ctx) => {
      if (!sandboxing) ctx.skip();
      await sb.ok("tm1_create_sandbox", { sandboxName: MANAGED });
      const row = (await listSandboxes(sb)).find((s) => s.name === MANAGED);
      expect(row?.managed).toBe(true);

      const w = await sb.ok("tm1_write_cells", writeCell(40, MANAGED));
      expect(w.json.verified.mismatches).toEqual([]);
      expect(await cellAt(sb, MANAGED)).toBe(40);
      expect(await cellAt(h)).toBe(30);

      await sb.ok("tm1_delete_sandbox", {
        sandboxName: MANAGED,
        confirm: MANAGED,
      });
      expect((await listSandboxes(sb)).some((s) => s.name === MANAGED)).toBe(
        false,
      );
    });
  });
});
