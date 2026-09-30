// Live checks for tm1_rest_read / tm1_rest_write: the paths the prompts, hints
// and skills name must work on a real server, and the guard must refuse what
// the kept tools own. Also pins what TM1 does when asked to delete a
// dimension's same-named hierarchy (the old tm1_delete_hierarchy refused it
// client-side; the REST tools only ask for confirm).
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
  names,
  restGet,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const DIM = `${SANDBOX}_REST_DIM`;
const DIM2 = `${SANDBOX}_REST_DIM2`;
const ALT = `${SANDBOX}_REST_ALT`;
const CUBE = `${SANDBOX}_REST_CUBE`;
const SCRATCH = `${SANDBOX}_REST_SCRATCH`;

describe.skipIf(!LIVE_ENABLED)("live: REST tools", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    await dropIfExists(h, seg("Cubes", CUBE));
    for (const d of [DIM, DIM2, SCRATCH])
      await dropIfExists(h, seg("Dimensions", d));
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, DIM, [
      { name: "Total", children: ["A", { name: "B", weight: -1 }] },
      "A",
      "B",
    ]);
    await createDimension(h, DIM2, ["M"]);
    await createCube(h, CUBE, [DIM, DIM2]);
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("reads", () => {
    it("filters control objects out with not startswith(Name,'}')", async () => {
      const all = await names(h, "Cubes");
      const plain = await restGet<Array<{ Name: string }>>(
        h,
        "Cubes?$select=Name&$filter=not startswith(Name,'}')",
      );
      expect(all.some((n) => n.startsWith("}"))).toBe(true);
      expect(plain.some((c) => c.Name.startsWith("}"))).toBe(false);
      expect(plain.map((c) => c.Name)).toContain(CUBE);
    });

    it("needs tolower() for a case-insensitive name match", async () => {
      const lower = DIM.toLowerCase();
      const exact = await restGet<unknown[]>(
        h,
        `Dimensions?$select=Name&$filter=contains(Name,'${lower}')`,
      );
      const folded = await restGet<Array<{ Name: string }>>(
        h,
        `Dimensions?$select=Name&$filter=contains(tolower(Name),'${lower}')`,
      );
      expect(exact).toHaveLength(0);
      expect(folded.map((d) => d.Name)).toContain(DIM);
    });

    it("reads a cube's dimensions and a hierarchy's elements and edges", async () => {
      const cube = await restGet<{ Dimensions: Array<{ Name: string }> }>(
        h,
        `${seg("Cubes", CUBE)}?$select=Name&$expand=Dimensions($select=Name)`,
      );
      // With sandboxing on, TM1 lists the shared Sandboxes dimension first.
      expect(
        cube.Dimensions.map((d) => d.Name).filter((n) => n !== "Sandboxes"),
      ).toEqual([DIM, DIM2]);

      const hier = `${seg("Dimensions", DIM)}/${seg("Hierarchies", DIM)}`;
      const els = await restGet<Array<{ Name: string; Type: string }>>(
        h,
        `${hier}/Elements?$select=Name,Type`,
      );
      expect(els.map((e) => e.Name).sort()).toEqual(["A", "B", "Total"]);
      const edges = await restGet<
        Array<{ ParentName: string; ComponentName: string; Weight: number }>
      >(h, `${hier}/Edges`);
      expect(edges.find((e) => e.ComponentName === "B")?.Weight).toBe(-1);

      const count = await h.ok("tm1_rest_read", {
        path: `${hier}/Elements/$count`,
      });
      expect(Number(count.json.text ?? count.json.data)).toBe(3);
    });

    it("reads threads (v11) or jobs (v12), sessions and the caller's groups", async () => {
      const running = await restGet<unknown[]>(
        h,
        h.client.version === 12
          ? "Jobs"
          : "Threads?$select=ID,Type,Name,State,Function,ObjectName,ElapsedTime,WaitTime",
      );
      expect(Array.isArray(running)).toBe(true);
      const sessions = await restGet<unknown[]>(
        h,
        "Sessions?$select=ID&$expand=User($select=Name)",
      );
      expect(sessions.length).toBeGreaterThan(0);
      const groups = await restGet<Array<{ Name: string }>>(
        h,
        "ActiveUser/Groups?$select=Name",
      );
      expect(groups.length).toBeGreaterThan(0);
    });

    it("reads the message log with a contains() filter, newest first (v11)", async (ctx) => {
      if (h.client.version === 12) ctx.skip("v12 serves the log empty");
      const rows = await restGet<Array<{ TimeStamp: string; Message: string }>>(
        h,
        "MessageLogEntries?$filter=contains(Message,'TM1')&$orderby=TimeStamp desc&$top=5",
      );
      expect(rows.length).toBeGreaterThan(0);
      const stamps = rows.map((r) => r.TimeStamp);
      expect([...stamps].sort().reverse()).toEqual(stamps);
    });

    it("bounds a transaction-log read by TimeStamp (v11)", async (ctx) => {
      if (h.client.version === 12) ctx.skip("v12 serves the log empty");
      const since = new Date(Date.now() - 3_600_000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z");
      const rows = await restGet<unknown[]>(
        h,
        `TransactionLogEntries?$filter=Cube eq '${CUBE}' and TimeStamp ge ${since}&$orderby=TimeStamp desc&$top=30`,
      );
      expect(Array.isArray(rows)).toBe(true);
    });

    it("compiles a process through the read tool", async () => {
      const [proc] = await restGet<Array<{ Name: string }>>(
        h,
        "Processes?$select=Name&$filter=not startswith(Name,'}')&$top=1",
      );
      const r = await h.ok("tm1_rest_read", {
        path: `${seg("Processes", proc!.Name)}/tm1.Compile`,
      });
      expect(r.isError).toBe(false);
    });
  });

  describe("writes", () => {
    it("adds an element attribute and patches an element", async () => {
      const hier = `${seg("Dimensions", DIM)}/${seg("Hierarchies", DIM)}`;
      await restWrite(h, "POST", `${hier}/ElementAttributes`, {
        Name: "Caption",
        Type: "Alias",
      });
      const attrs = await names(h, `${hier}/ElementAttributes`);
      expect(attrs).toContain("Caption");
      await restWrite(h, "PATCH", `${hier}/Elements('A')`, { Name: "A" });
    });

    it("adds and deletes a second hierarchy", async () => {
      const dim = seg("Dimensions", DIM);
      await restWrite(h, "POST", `${dim}/Hierarchies`, { Name: ALT });
      expect(await names(h, `${dim}/Hierarchies`)).toContain(ALT);
      await restWrite(h, "DELETE", `${dim}/${seg("Hierarchies", ALT)}`);
      expect(await names(h, `${dim}/Hierarchies`)).not.toContain(ALT);
    });

    it("refuses a DELETE without the matching confirm", async () => {
      const r = await h.call("tm1_rest_write", {
        method: "DELETE",
        path: seg("Cubes", CUBE),
        confirm: "wrong",
      });
      expect(r.isError).toBe(true);
      expect(await names(h, "Cubes", CUBE)).toEqual([CUBE]);
    });

    it("refuses what a kept tool owns: rules, process bodies, cell writes", async () => {
      const cases: Array<[string, string, unknown]> = [
        ["PATCH", seg("Cubes", CUBE), { Rules: "SKIPCHECK;" }],
        ["POST", "Processes", { Name: `${SANDBOX}_REST_P` }],
        ["POST", `${seg("Cubes", CUBE)}/tm1.Update`, {}],
      ];
      for (const [method, path, body] of cases) {
        const r = await h.call("tm1_rest_write", { method, path, body });
        expect(r.isError, `${method} ${path}`).toBe(true);
      }
    });

    // Measured 2026-09-30 on 11.8.03500 before the guard refused it: TM1
    // answers this DELETE with success and leaves the dimension with no
    // hierarchy at all.
    it("refuses to delete a dimension's same-named hierarchy", async () => {
      await createDimension(h, SCRATCH, ["X"]);
      const dim = seg("Dimensions", SCRATCH);
      const r = await h.call("tm1_rest_write", {
        method: "DELETE",
        path: `${dim}/${seg("Hierarchies", SCRATCH)}`,
        confirm: SCRATCH,
      });
      expect(r.isError).toBe(true);
      expect(r.json.hint).toContain("DELETE Dimensions(");
      expect(await names(h, `${dim}/Hierarchies`)).toContain(SCRATCH);
    });
  });
});
