// Live integration: the cross-connection comparison tools. The harness has one
// connection, so connectionB defaults to it: comparing the live model with
// itself must come back identical, which exercises every read path (rules,
// hierarchy structure with edges, process code, chores) against the real
// server. Strictly read-only.
import { describe, it, expect, beforeAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  restGet,
  type LiveHarness,
} from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: cross-connection compare", () => {
  let h: LiveHarness;
  let ruleCube: string | undefined;
  let otherCube: string | undefined;
  let dimension: string | undefined;
  let processName: string | undefined;

  beforeAll(async () => {
    h = await getHarness();
    const cubes = await restGet<Array<{ Name: string; Rules?: string }>>(
      h,
      "Cubes?$select=Name,Rules&$filter=not startswith(Name,'}')",
    );
    ruleCube = cubes.find((c) => c.Rules)?.Name;
    otherCube = cubes.find((c) => c.Name !== ruleCube)?.Name;
    dimension = (
      await restGet<Array<{ Name: string }>>(
        h,
        "Dimensions?$select=Name&$filter=not startswith(Name,'}')&$top=1",
      )
    )[0]?.Name;
    processName = (
      await restGet<Array<{ Name: string }>>(
        h,
        "Processes?$select=Name&$filter=not startswith(Name,'}')&$top=1",
      )
    )[0]?.Name;
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
