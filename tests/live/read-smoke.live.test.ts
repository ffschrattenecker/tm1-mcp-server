// Read-tier smoke: non-mutating tools against the live server. Validates the
// harness mechanism (registry capture, schema parsing, error normalization)
// and the read surface. Mutates nothing — also passes against a readonly-mode
// server's tool set.
import { describe, it, expect, beforeAll } from "vitest";
import { getHarness, LIVE_ENABLED, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: read smoke", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
  });

  it("registers the full readwrite tool set", () => {
    const names = h.toolNames();
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain("tm1_rest_read");
    expect(names).toContain("tm1_write_cells"); // readwrite-only tool present
  });

  it("get_server_state returns version", async () => {
    const r = await h.ok("tm1_get_server_state");
    expect(r.json).toBeTruthy();
    expect(JSON.stringify(r.json)).toMatch(/\d+\.\d+/);
  });

  it("rest_read lists cubes, dimensions and processes", async () => {
    for (const coll of ["Cubes", "Dimensions", "Processes"]) {
      const r = await h.ok("tm1_rest_read", {
        path: `${coll}?$select=Name&$top=5`,
      });
      expect(r.json.data.value, coll).toBeInstanceOf(Array);
    }
  });

  it("a refused REST path yields a canonical error envelope with a hint", async () => {
    const r = await h.call("tm1_rest_read", { path: "$batch" });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
    expect(r.json.hint).toBeTruthy();
  });

  it("unknown dimension returns an error envelope, not a throw", async () => {
    const r = await h.call("tm1_rest_read", {
      path: "Dimensions('ZZ_MCP_LIVE_DOES_NOT_EXIST')/Hierarchies('ZZ_MCP_LIVE_DOES_NOT_EXIST')",
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });
});
