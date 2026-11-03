import { describe, it, expect } from "vitest";
import {
  buildReferenceIndex,
  type ReferenceIndex,
} from "../../src/lib/callgraph/referenceIndex.js";
import {
  buildCallGraph,
  type CallGraphNode,
} from "../../src/lib/callgraph/callGraph.js";
import { serializeNode } from "../../src/lib/callgraph/serialize.js";
import { globalRanking } from "../../src/tools/analysis/analyze-callgraph.js";
import { CallgraphResultSchema } from "../../src/tools/schemas/items.js";

// ─────────────────────────────────────────────────────────────────────────────
// serializeCompact and summarize live private inside
// src/tools/analysis/analyze-callgraph.ts, so they are mirrored VERBATIM below.
// If the real ones change, this copy must change with them. serializeNode is
// imported from src/lib/callgraph/serialize.ts. globalRanking is exported and
// used directly.
// ─────────────────────────────────────────────────────────────────────────────

interface CompactNode {
  process: string;
  cycle?: boolean;
  depthLimitReached?: boolean;
  unresolvedCalls?: Array<{
    section: string;
    line: number;
    funcName: string;
    expr: string;
    reason: string;
  }>;
  children: CompactNode[];
}

function serializeCompact(node: CallGraphNode): CompactNode {
  const out: CompactNode = {
    process: node.process,
    children: node.children.map(serializeCompact),
  };
  if (node.cycle) out.cycle = true;
  if (node.depthLimitReached) out.depthLimitReached = true;
  if (node.unresolvedCalls && node.unresolvedCalls.length > 0) {
    out.unresolvedCalls = node.unresolvedCalls.map((u) => ({
      section: u.section,
      line: u.line,
      funcName: u.funcName,
      expr: u.expr,
      reason: u.reason,
    }));
  }
  return out;
}

interface SummaryEntry {
  process: string;
  depthMin: number;
  depthMax: number;
  occurrences: number;
  cycle: boolean;
  depthLimitReached: boolean;
  unresolvedCount: number;
}

function summarize(root: CallGraphNode): unknown {
  const map = new Map<string, SummaryEntry>();
  let totalNodes = 0;
  let maxDepth = 0;
  let cyclesDetected = 0;
  let depthLimitsHit = 0;

  function walk(node: CallGraphNode, depth: number): void {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const isCycle = !!node.cycle;
    const isDepthLimit = !!node.depthLimitReached;
    if (isCycle) cyclesDetected++;
    if (isDepthLimit) depthLimitsHit++;

    const existing = map.get(node.process);
    if (existing) {
      existing.occurrences++;
      if (depth < existing.depthMin) existing.depthMin = depth;
      if (depth > existing.depthMax) existing.depthMax = depth;
      existing.cycle = existing.cycle || isCycle;
      existing.depthLimitReached = existing.depthLimitReached || isDepthLimit;
    } else {
      map.set(node.process, {
        process: node.process,
        depthMin: depth,
        depthMax: depth,
        occurrences: 1,
        cycle: isCycle,
        depthLimitReached: isDepthLimit,
        unresolvedCount: node.unresolvedCalls?.length ?? 0,
      });
    }

    for (const child of node.children) walk(child, depth + 1);
  }

  walk(root, 0);

  const processes = Array.from(map.values()).sort((a, b) => {
    if (a.depthMin !== b.depthMin) return a.depthMin - b.depthMin;
    return b.occurrences - a.occurrences;
  });

  return {
    root: root.process,
    totalNodes,
    uniqueProcesses: map.size,
    maxDepth,
    cyclesDetected,
    depthLimitsHit,
    processes,
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────
// Parent → Child (resolved edge with literal + dynamic params, env propagation),
// Child → Parent (cycle), and Parent has a dynamic unresolvedCalls entry.
async function buildTestIndex(): Promise<ReferenceIndex> {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      {
        name: "Parent",
        prolog:
          "ExecuteProcess('Child', 'pIn', 'UK', 'pDyn', NumberToString(1|2));\nsDyn = sOther;\nExecuteProcess(sDyn);",
        metadata: "",
        data: "",
        epilog: "",
        parameters: ["pRegion"],
      },
      {
        name: "Child",
        prolog: "ExecuteProcess('Parent');",
        metadata: "",
        data: "",
        epilog: "",
        parameters: ["pIn"],
      },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

// Mirror the guard: it validates JSON.parse(JSON.stringify(payload)).
function roundTrip(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload));
}

/** Asserts the payload parses after the same JSON round trip the guard sees. */
function expectValid(payload: unknown): void {
  const parsed = CallgraphResultSchema.safeParse(roundTrip(payload));
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
}

describe("CallgraphResultSchema — validates every emitted shape", () => {
  it("validates the full-tree payload (mode='full')", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    expectValid({
      start: "Parent",
      direction: "downstream",
      mode: "full",
      maskSecrets: false,
      tree: serializeNode(tree, false, { unresolvedCalls: true }),
    });
  });

  it("validates the full-tree payload with masking on", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    expectValid({
      start: "Parent",
      direction: "downstream",
      mode: "full",
      maskSecrets: true,
      tree: serializeNode(tree, true, { unresolvedCalls: true }),
    });
  });

  it("validates the compact-tree payload (mode='compact')", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    expectValid({
      start: "Parent",
      direction: "downstream",
      mode: "compact",
      tree: serializeCompact(tree),
    });
  });

  it("validates the upstream full-tree payload (no env)", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Child", { direction: "upstream" });
    expectValid({
      start: "Child",
      direction: "upstream",
      mode: "full",
      maskSecrets: false,
      tree: serializeNode(tree, false, { unresolvedCalls: true }),
    });
  });

  it("validates the summary payload (mode='summary')", async () => {
    const index = await buildTestIndex();
    const tree = buildCallGraph(index, "Parent", { direction: "downstream" });
    expectValid({
      start: "Parent",
      direction: "downstream",
      mode: "summary",
      maskSecrets: false,
      summary: summarize(tree),
    });
  });

  it("validates the globalRanking payload (start omitted)", async () => {
    const index = await buildTestIndex();
    const result = globalRanking(index, {
      rankBy: "outgoing",
      topN: 50,
      includeSystem: false,
    });
    expectValid({ mode: "globalRanking", ...result });
  });

  it("validates the warning payload (process not found)", async () => {
    const index = await buildTestIndex();
    expectValid({
      warning: `Process "Nope" not found in index.`,
      indexedProcessCount: index.processParams.size,
    });
  });

  it("still ACCEPTS well-formed nodes in both modes", () => {
    expectValid({
      mode: "full",
      tree: {
        process: "P",
        cycle: false,
        depthLimitReached: false,
        incomingEdge: null,
        children: [],
      },
    });
    expectValid({
      mode: "compact",
      tree: { process: "P", children: [{ process: "C", children: [] }] },
    });
  });
});

describe("CallgraphResultSchema — rejects malformed shapes", () => {
  it("REJECTS a structurally-wrong tree (children is a string)", () => {
    const bad = {
      start: "Parent",
      direction: "downstream",
      mode: "full",
      maskSecrets: false,
      tree: {
        process: "Parent",
        cycle: false,
        incomingEdge: null,
        children: "not-an-array",
      },
    };
    expect(CallgraphResultSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  it("REJECTS a tree node missing `process`", () => {
    const bad = {
      start: "Parent",
      direction: "downstream",
      mode: "full",
      tree: { cycle: false, incomingEdge: null, children: [] },
    };
    expect(CallgraphResultSchema.safeParse(roundTrip(bad)).success).toBe(false);
  });

  it("REJECTS a wrongly-typed node field that both tree shapes declare", () => {
    const bad = {
      mode: "full",
      tree: {
        process: "Parent",
        cycle: "yes",
        incomingEdge: null,
        children: [],
      },
    };
    expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
  });

  // `tree` is a union of FullNode | CompactNode. A non-strict Zod object STRIPS
  // unknown keys rather than rejecting them, which used to let a corrupt
  // full-mode node slip through by matching the compact variant with the corrupt
  // keys thrown away. Both variants are `.strict()`; these are the cases that
  // were silently accepted before.
  it.each([
    [
      "a stray key on a compact-shaped node",
      { mode: "compact", tree: { process: "P", children: [], bogus: 1 } },
    ],
    [
      "a stray key nested in children",
      {
        mode: "compact",
        tree: {
          process: "P",
          children: [{ process: "C", children: [], junk: true }],
        },
      },
    ],
    [
      "a corrupt env value kind",
      {
        mode: "full",
        tree: {
          process: "P",
          cycle: false,
          incomingEdge: null,
          env: { v: { kind: "nope" } },
          children: [],
        },
      },
    ],
    [
      "a non-numeric incomingEdge line",
      {
        mode: "full",
        tree: {
          process: "P",
          cycle: false,
          incomingEdge: {
            caller: "a",
            callee: "b",
            section: "s",
            line: "NOT-A-NUMBER",
            funcName: "f",
            snippet: "x",
            params: [],
          },
          children: [],
        },
      },
    ],
  ])(
    "REJECTS %s instead of stripping it into the other union variant",
    (_label, bad) => {
      expect(CallgraphResultSchema.safeParse(bad).success).toBe(false);
    },
  );
});
