// Live integration: the ANALYSIS / AUDIT domain against the configured live
// model, through the real tool layer (zod schema → withAnnotations → handler →
// TM1Client → OData). Only the runtime evidence paths are exercised here: the
// static and envelope-only audit calls are covered by the unit suites.
//
// Read-only except for one sandbox process, which the callgraph invalidation
// test writes to prove a process write (and not an MDX read) drops the index.
// It is removed in afterAll. Real object names (cubes, processes, rule-bearing
// cubes, real cell coordinates) are discovered dynamically, never hardcoded, so
// the suite adapts to whatever the live model contains.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  restGet,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";
import {
  buildIndexFromTM1,
  __testing,
  invalidateCallgraphCache,
  registerCallgraphCacheInvalidation,
} from "../../src/lib/callgraph/tm1-adapter.js";

const PROBE_PROC = `${SANDBOX}_ANALYSIS_PROBE`;

/** Non-control cubes with their rules flag and dimension names (dim order). */
async function cubesWithDimensions(
  h: LiveHarness,
): Promise<Array<{ name: string; hasRules: boolean; dimensions: string[] }>> {
  const rows = await restGet<
    Array<{
      Name: string;
      Rules?: string | null;
      Dimensions: Array<{ Name: string }>;
    }>
  >(
    h,
    "Cubes?$select=Name,Rules&$filter=not startswith(Name,'}')&$expand=Dimensions($select=Name)",
  );
  return rows.map((c) => ({
    name: c.Name,
    hasRules: Boolean(c.Rules?.trim()),
    dimensions: c.Dimensions.map((d) => d.Name),
  }));
}

describe.skipIf(!LIVE_ENABLED)("live: analysis / audit domain", () => {
  let h: LiveHarness;

  // Discovered once in beforeAll and reused across tests.
  let cubeNames: string[] = [];
  let processNames: string[] = [];
  let ruleCube: string | undefined; // a non-control cube that has rules
  let sampleCube: string | undefined; // rule cube we found a real cell in
  let sampleElements: string[] | undefined; // real cell coords, dim order

  beforeAll(async () => {
    h = await getHarness();
    // Leftover probe from an interrupted run: an overwrite needs confirm.
    await dropIfExists(h, seg("Processes", PROBE_PROC));

    // ── Discover real cubes (with hasRules) and processes ──────────────────
    const cubeItems = await cubesWithDimensions(h);
    cubeNames = cubeItems.map((c) => c.name);

    processNames = (
      await restGet<Array<{ Name: string }>>(h, "Processes?$select=Name")
    ).map((p) => p.Name);

    // ── Find a rule-bearing cube and a real populated cell inside it ───────
    const ruleCubes = cubeItems.filter(
      (c) => c.hasRules && !c.name.startsWith("}"),
    );
    for (const c of ruleCubes) {
      ruleCube ??= c.name;
      const dims = c.dimensions ?? [];
      if (dims.length === 0) continue;
      // sample_cells returns self-describing {coordinates: {dim->el}} cells.
      const sample = await h.call("tm1_sample_cells", {
        cubeName: c.name,
        maxCells: 1,
      });
      const cell = sample.json?.cells?.[0];
      const coords: Record<string, string> | undefined = cell?.coordinates;
      if (!coords) continue;
      const els = dims.map((d) => coords[d]);
      if (els.every((e) => typeof e === "string" && e.length > 0)) {
        sampleCube = c.name;
        sampleElements = els;
        break;
      }
    }
  });

  afterAll(async () => {
    await dropIfExists(h, seg("Processes", PROBE_PROC));
  });

  // ── object usage (cube reference scan) ──────────────────────────────────
  it("tm1_analyze_object_usage: cube reference scan", async () => {
    expect(cubeNames.length).toBeGreaterThan(0);
    const r = await h.ok("tm1_analyze_object_usage", {
      kind: "cube",
      objectName: cubeNames[0],
      limit: 50,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      kind: "cube",
      count: expect.any(Number),
      usages: expect.any(Array),
    });

    const s = await h.ok("tm1_analyze_object_usage", {
      kind: "cube",
      objectName: cubeNames[0],
      mode: "summary",
      limit: 50,
    });
    expect(s.isError).toBe(false);
    expect(s.json).toMatchObject({
      kind: "cube",
      mode: "summary",
      sourceCount: expect.any(Number),
      sources: expect.any(Array),
    });
    const sources = s.json.sources as Array<{ count: number }>;
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i - 1].count).toBeGreaterThanOrEqual(sources[i].count);
    }
  });

  // ── callgraph ───────────────────────────────────────────────────────────
  it("tm1_analyze_callgraph: downstream from a real process (compact)", async () => {
    expect(processNames.length).toBeGreaterThan(0);
    const r = await h.ok("tm1_analyze_callgraph", {
      start: processNames[0],
      direction: "downstream",
      mode: "compact",
      maxDepth: 3,
    });
    expect(r.isError).toBe(false);
    // Either a tree payload, or a structured "not found in index" warning —
    // both are valid non-error JSON shapes for a real-but-leaf process.
    expect(r.json).toBeTruthy();
    expect(r.json.tree !== undefined || r.json.warning !== undefined).toBe(
      true,
    );
  });

  it("tm1_analyze_callgraph: global fan-out ranking (no start)", async () => {
    const r = await h.ok("tm1_analyze_callgraph", {
      rankBy: "outgoing",
      topN: 10,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ mode: "globalRanking" });
    // Ranking returns an array of per-process entries under some key.
    const arr = r.json.ranking ?? r.json.entries ?? r.json.processes;
    expect(Array.isArray(arr)).toBe(true);
  });

  it("tm1_analyze_callgraph refresh:true rebuilds the index and answers", async () => {
    if (processNames.length === 0) return;
    const r = await h.ok("tm1_analyze_callgraph", {
      start: processNames[0],
      direction: "downstream",
      mode: "compact",
      refresh: true,
    });
    expect(r.isError).toBe(false);
  });

  // Only code-relevant mutations may drop the index.
  it("callgraph index: an MDX read does NOT discard it, a process write does", async () => {
    registerCallgraphCacheInvalidation();
    invalidateCallgraphCache();

    await buildIndexFromTM1(h.client);
    expect(__testing.cachedKeys()).toHaveLength(1);

    const cube = cubeNames[0];
    expect(cube).toBeTruthy();

    // ExecuteMDX is a POST, so the HTTP layer emits a mutation event for it.
    // Before the fix this alone threw the whole index away. Whether the query
    // itself succeeds is irrelevant — the POST is what used to invalidate.
    await h.call("tm1_execute_mdx", {
      mdx: `SELECT {} ON COLUMNS FROM [${cube}]`,
      limit: 1,
    });
    expect(__testing.cachedKeys()).toHaveLength(1);

    // A process write genuinely changes the reference graph: must invalidate.
    await h.ok("tm1_upsert_process", {
      processName: PROBE_PROC,
      prolog: "# analysis live probe",
    });
    expect(__testing.cachedKeys()).toHaveLength(0);
  });

  // ---- audit_complexity: consistency scope fans out ------------------------
  it("audit_complexity consistency scope beats a serial walk of the same reads", async () => {
    const procs = (
      await restGet<Array<{ Name: string }>>(
        h,
        "Processes?$select=Name&$filter=not startswith(Name,'}')&$top=500",
      )
    ).map((p) => p.Name);
    if (procs.length < 8) {
      console.log(
        `[audit_complexity] only ${procs.length} processes — timing not telling`,
      );
      return;
    }

    // Measure one round-trip to get this server's per-call latency.
    const t0 = Date.now();
    await h.client.processes.getVariables(procs[0]);
    const singleMs = Math.max(1, Date.now() - t0);

    const t1 = Date.now();
    const res = await h.ok("tm1_audit_complexity", {
      scope: ["consistency"],
    });
    const fanOutMs = Date.now() - t1;

    const serialEstimateMs = singleMs * procs.length;
    console.log(
      `[audit_complexity] ${procs.length} processes: single=${singleMs}ms, ` +
        `serial estimate=${serialEstimateMs}ms, actual=${fanOutMs}ms`,
    );
    expect(res.isError).toBe(false);
    // 8 in flight; allow generous slack for server-side contention and the
    // scope's own aggregation work, but a serial walk cannot land here.
    expect(fanOutMs).toBeLessThan(serialEstimateMs);
  });

  // ── get_cube_stats: real cube ───────────────────────────────────────────
  // Version-dependent by construction: v11 11.8 carries all seven }Stats*
  // control cubes, v12 12.5.9 carries none (measured — it has only security
  // and element-attribute control cubes). Both outcomes are asserted; the v12
  // branch is a real assertion on the degradation, not a skip.
  it("tm1_get_cube_stats: single real cube", async () => {
    expect(cubeNames.length).toBeGreaterThan(0);
    const r = await h.ok("tm1_get_cube_stats", { cubeName: cubeNames[0] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      count: expect.any(Number),
      items: expect.any(Array),
    });
    expect(r.json.items[0]).toMatchObject({ cubeName: expect.any(String) });

    if (h.client.version === 12) {
      // No }Stats* cubes on Planning Analytics Engine: the tool must say so
      // in prose, not leak "'}StatsByCube' can not be found in collection…".
      expect(r.json.statsUnavailable?.reason).toBe("absent");
      expect(r.json.statsUnavailable.message).not.toMatch(/collection of type/);
      expect(r.json.items[0].error).toBe(r.json.statsUnavailable.message);
    } else {
      expect(r.json.statsUnavailable).toBeUndefined();
      expect(r.json.items[0].error).toBeUndefined();
      // }StatsByCube answered: the raw measure map is populated.
      expect(Object.keys(r.json.items[0].raw ?? {}).length).toBeGreaterThan(0);
    }
  });

  // ── audit_feeders runtime evidence: present on v11, degraded on v12 ──────
  it("tm1_audit_feeders: runtime mode reports evidence (v11) or its absence (v12)", async () => {
    const r = await h.ok("tm1_audit_feeders", {
      mode: "both",
      topN: 5,
      severityThreshold: "none",
    });
    expect(r.isError).toBe(false);
    if (h.client.version === 12) {
      expect(r.json.runtimeUnavailable?.reason).toBe("absent");
      expect(r.json.runtimeUnavailable.message).not.toMatch(
        /collection of type/,
      );
      // The static half still ran.
      expect(r.json.scanned.cubes).toBeGreaterThan(0);
      expect(r.json.status).toBe("pass"); // severityThreshold: none
    } else {
      expect(r.json.runtimeUnavailable).toBeUndefined();
      expect(r.json.scanned.runtimeAvailable).toBeGreaterThan(0);
    }
  });

  // ── check_feeders (v11 runtime, real cell) ──────────────────────────────
  it("tm1_check_feeders: real cell in a rule-bearing cube", async () => {
    if (!sampleCube || !sampleElements) {
      // No rule cube with a discoverable populated cell — skip gracefully.
      return;
    }
    const r = await h.call("tm1_check_feeders", {
      cubeName: sampleCube,
      elements: sampleElements,
    });
    // Empty fedCells (fully-fed) is a valid non-error result on 11.8.
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      count: expect.any(Number),
      fedCells: expect.any(Array),
    });
  });

  // ── alternate-hierarchy addressing (Hier:Elem) ──────────────────────────
  // The three cell diagnostics used to state that alternate hierarchies were
  // not supported. Measured on 11.8 and 12.5.9: an entry written `Hier:Elem`
  // addresses the alternate rollup and BOTH halves are validated — a wrong
  // hierarchy fails exactly like a wrong element, so a passing call is real
  // resolution and not a tolerated string.
  //
  // Deliberately independent of the rule-cube discovery above: CheckFeeders
  // resolves a coordinate on any cube, and tying this to a populated rule cell
  // made it skip its own body on a model without one (which is how it passed
  // against v12 while proving nothing). Needs only a cube one of whose
  // dimensions carries a second hierarchy.
  it("tm1_check_feeders: Hier:Elem addresses an alternate hierarchy", async () => {
    const dimList = await restGet<
      Array<{ Name: string; Hierarchies: Array<{ Name: string }> }>
    >(h, "Dimensions?$select=Name&$expand=Hierarchies($select=Name)");
    const hierarchiesOf = new Map<string, string[]>(
      dimList.map((d) => [d.Name, d.Hierarchies.map((x) => x.Name)]),
    );

    const cubeItems = await cubesWithDimensions(h);

    // One element per dimension, taken from its DEFAULT hierarchy. The cell
    // need not hold data — only the coordinate has to resolve.
    const firstElement = async (
      dim: string,
      hier: string,
    ): Promise<string | undefined> => {
      const r = await h.call("tm1_rest_read", {
        path: `${seg("Dimensions", dim)}/${seg("Hierarchies", hier)}/Elements?$select=Name&$top=1`,
      });
      return r.json?.data?.value?.[0]?.Name;
    };

    let probe:
      | { cube: string; coords: string[]; slot: number; altHier: string }
      | undefined;

    for (const c of cubeItems) {
      const dims = c.dimensions ?? [];
      if (dims.length === 0) continue;
      const slot = dims.findIndex((d) =>
        (hierarchiesOf.get(d) ?? []).some((hRaw) => hRaw !== d),
      );
      if (slot < 0) continue;
      const altHier = (hierarchiesOf.get(dims[slot]) ?? []).find(
        (hRaw) => hRaw !== dims[slot],
      );
      if (!altHier) continue;

      const coords = await Promise.all(dims.map((d) => firstElement(d, d)));
      if (!coords.every((e): e is string => typeof e === "string" && e !== ""))
        continue;

      const altElement = await firstElement(dims[slot], altHier);
      if (!altElement) continue;

      coords[slot] = `${altHier}:${altElement}`;
      probe = { cube: c.name, coords, slot, altHier };
      break;
    }

    // A model with no alternate hierarchy anywhere cannot exercise this.
    if (!probe) return;

    const ok = await h.call("tm1_check_feeders", {
      cubeName: probe.cube,
      elements: probe.coords,
    });
    expect(ok.isError).toBe(false);

    // Negative control. Without it the pass above would also hold if the
    // hierarchy half were ignored and only the element name resolved.
    const bogus = [...probe.coords];
    const element = probe.coords[probe.slot].slice(probe.altHier.length + 1);
    bogus[probe.slot] = `ZZ_NO_SUCH_HIERARCHY:${element}`;
    const bad = await h.call("tm1_check_feeders", {
      cubeName: probe.cube,
      elements: bogus,
    });
    expect(bad.isError).toBe(true);
  });

  // ── trace_feeders (v11 runtime, real cell) ──────────────────────────────
  it("tm1_trace_feeders: real cell in a rule-bearing cube", async () => {
    if (!sampleCube || !sampleElements) return;
    const r = await h.call("tm1_trace_feeders", {
      cubeName: sampleCube,
      elements: sampleElements,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      count: expect.any(Number),
      fedCells: expect.any(Array),
    });
  });

  // ── trace_cell_calculation (v11 runtime, real cell) ─────────────────────
  it("tm1_trace_cell_calculation: real cell component tree", async () => {
    if (!sampleCube || !sampleElements) return;
    const r = await h.call("tm1_trace_cell_calculation", {
      cubeName: sampleCube,
      elements: sampleElements,
      maxDepth: 2,
      maxComponents: 10,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
    expect(typeof r.json).toBe("object");
  });
});
