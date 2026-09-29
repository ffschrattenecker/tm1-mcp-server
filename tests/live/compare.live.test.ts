// Live integration: the cross-connection comparison tools. The harness has one
// connection, so connectionB defaults to it: comparing the live model with
// itself must come back identical, which exercises every read path (rules,
// hierarchy structure with edges, process code, chores) against the real
// server. Strictly read-only.
import { describe, it, expect, beforeAll } from "vitest";
import { getHarness, LIVE_ENABLED, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: cross-connection compare", () => {
  let h: LiveHarness;
  let ruleCube: string | undefined;
  let otherCube: string | undefined;
  let dimension: string | undefined;
  let processName: string | undefined;

  beforeAll(async () => {
    h = await getHarness();
    const cubes = await h.ok("tm1_list_cubes", {
      fetchAll: true,
      includeRules: true,
      includeControl: false,
    });
    const items: Array<{ name: string; hasRules?: boolean }> =
      cubes.json?.items ?? [];
    ruleCube = items.find((c) => c.hasRules)?.name;
    otherCube = items.find((c) => c.name !== ruleCube)?.name;
    const dims = await h.ok("tm1_list_dimensions", { fetchAll: true });
    dimension = (dims.json?.items ?? [])
      .map((d: { name: string }) => d.name)
      .find((n: string) => !n.startsWith("}"));
    const procs = await h.ok("tm1_list_processes", { fetchAll: true });
    processName = (procs.json?.items ?? [])
      .map((p: string | { name: string }) =>
        typeof p === "string" ? p : p.name,
      )
      .find((n: string) => !n.startsWith("}"));
  });

  it("tm1_compare_environments: the model equals itself", async () => {
    const r = await h.ok("tm1_compare_environments", {});
    expect(r.json.identical).toBe(true);
    expect(r.json.cubes.countA).toBeGreaterThan(0);
    expect(r.json.cubes.countA).toBe(r.json.cubes.countB);
    expect(r.json.processes.differs).toEqual([]);
  });

  it("tm1_compare_environments deep: one dimension's structure equals itself", async () => {
    if (!dimension) return;
    const r = await h.ok("tm1_compare_environments", {
      objectTypes: ["dimensions"],
      nameRegex: `^${dimension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      deep: true,
    });
    expect(r.json.dimensions.countA).toBe(1);
    expect(r.json.dimensions.identical).toBe(1);
  });

  it("tm1_diff_cube_rules: a rule cube equals itself, and differs from another cube", async () => {
    if (!ruleCube) return;
    const same = await h.ok("tm1_diff_cube_rules", { cube: ruleCube });
    expect(same.json.identical).toBe(true);
    expect(same.json.rules.linesA).toBeGreaterThan(0);
    if (!otherCube) return;
    const other = await h.ok("tm1_diff_cube_rules", {
      cube: ruleCube,
      cubeB: otherCube,
    });
    expect(other.json.cubeB).toBe(otherCube);
  });

  it("tm1_diff_hierarchy: a dimension equals itself, edges included", async () => {
    if (!dimension) return;
    const r = await h.ok("tm1_diff_hierarchy", {
      dimension,
      includeAttributeValues: true,
    });
    expect(r.json.identical).toBe(true);
    expect(r.json.a.elements).toBe(r.json.b.elements);
    expect(r.json.a.edges).toBe(r.json.b.edges);
  });

  it("getStructure: small pages stitch to the single-page read", async () => {
    if (!dimension) return;
    const read = (pageSize?: number) =>
      h.client.hierarchies.getStructure(dimension!, dimension!, pageSize);
    const whole = await read();
    const paged = await read(Math.max(1, Math.ceil(whole.elements.length / 4)));
    const names = paged.elements.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    const sorted = (s: typeof whole) => ({
      elements: s.elements.map((e) => e.name).sort(),
      edges: s.edges.map((e) => `${e.parent}>${e.child}:${e.weight}`).sort(),
    });
    expect(sorted(paged)).toEqual(sorted(whole));
  });

  it("tm1_diff_processes: processB defaults to processA", async () => {
    if (!processName) return;
    const r = await h.ok("tm1_diff_processes", { processA: processName });
    expect(r.json.processB).toBe(processName);
    expect(r.json.identical).toBe(true);
  });
});
