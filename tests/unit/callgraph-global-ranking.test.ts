import { describe, it, expect } from "vitest";
import { globalRanking } from "../../src/tools/analysis/analyze-callgraph.js";
import { buildCallGraph } from "../../src/lib/callgraph/callGraph.js";
import { buildReferenceIndex } from "../../src/lib/callgraph/referenceIndex.js";
import type {
  ReferenceIndex,
  TmReference,
} from "../../src/lib/callgraph/referenceIndex.js";

function procRef(source: string, target: string): TmReference {
  return {
    sourceKind: "process",
    sourceName: source,
    section: "prolog",
    line: 0,
    snippet: `ExecuteProcess('${target}')`,
    funcName: "ExecuteProcess",
    targetKind: "process",
    targetName: target,
  };
}

function cubeRef(source: string, cube: string): TmReference {
  return {
    sourceKind: "process",
    sourceName: source,
    section: "data",
    line: 0,
    snippet: `CellGetN('${cube}', ...)`,
    funcName: "CellGetN",
    targetKind: "cube",
    targetName: cube,
  };
}

function mkIndex(all: TmReference[], procNames: string[]): ReferenceIndex {
  const processParams = new Map<string, string[]>();
  for (const p of procNames) processParams.set(p.toLowerCase(), []);
  return {
    all,
    byCube: new Map(),
    byDim: new Map(),
    byProcess: new Map(),
    bySourceProcess: new Map(),
    unresolvedCallsBySourceProcess: new Map(),
    byElement: new Map(),
    unresolvedElementRefsBySourceProcess: new Map(),
    subsetUsageByProcess: new Map(),
    processParams,
    processDefaults: new Map(),
    choreTasks: new Map(),
  };
}

describe("globalRanking", () => {
  it("ranks processes by outgoing call sites, with distinct callee count", () => {
    // Orchestrator calls A twice and B once. A calls B once. C calls nothing.
    const index = mkIndex(
      [
        procRef("Orchestrator", "A"),
        procRef("Orchestrator", "A"),
        procRef("Orchestrator", "B"),
        procRef("A", "B"),
        cubeRef("C", "Sales"), // non-process edge, ignored
      ],
      ["Orchestrator", "A", "B", "C"],
    );

    const res = globalRanking(index, {
      rankBy: "outgoing",
      topN: 50,
      includeControl: false,
    });

    expect(res.ranking[0].process).toBe("Orchestrator");
    expect(res.ranking[0].outgoingCalls).toBe(3);
    expect(res.ranking[0].outgoingDistinct).toBe(2);
    expect(res.totalProcessesIndexed).toBe(4);
    expect(res.totalCallEdges).toBe(4);

    const a = res.ranking.find((r) => r.process === "A")!;
    expect(a.outgoingCalls).toBe(1);
    expect(a.incomingCalls).toBe(2); // called twice by Orchestrator

    const b = res.ranking.find((r) => r.process === "B")!;
    expect(b.incomingCalls).toBe(2); // Orchestrator + A
    expect(b.incomingDistinct).toBe(2);
    expect(b.outgoingCalls).toBe(0);
  });

  it("ranks by incoming when rankBy=incoming", () => {
    const index = mkIndex(
      [procRef("X", "Hub"), procRef("Y", "Hub"), procRef("Hub", "Z")],
      ["X", "Y", "Hub", "Z"],
    );
    const res = globalRanking(index, {
      rankBy: "incoming",
      topN: 50,
      includeControl: false,
    });
    expect(res.ranking[0].process).toBe("Hub");
    expect(res.ranking[0].incomingCalls).toBe(2);
    expect(res.ranking[0].incomingDistinct).toBe(2);
  });

  it("excludes control processes unless includeControl", () => {
    const index = mkIndex(
      [procRef("}bedrock.server.wait", "A"), procRef("Real", "A")],
      ["}bedrock.server.wait", "Real", "A"],
    );
    const off = globalRanking(index, {
      rankBy: "outgoing",
      topN: 50,
      includeControl: false,
    });
    expect(off.ranking.some((r) => r.process.startsWith("}"))).toBe(false);
    expect(off.totalProcessesIndexed).toBe(2); // Real + A only

    const on = globalRanking(index, {
      rankBy: "outgoing",
      topN: 50,
      includeControl: true,
    });
    expect(on.ranking.some((r) => r.process.startsWith("}"))).toBe(true);
  });

  it("caps output at topN and flags truncation", () => {
    const refs: TmReference[] = [];
    const names: string[] = [];
    for (let i = 0; i < 10; i++) {
      names.push(`P${i}`);
      // P0 calls 10, P1 calls 9, ... descending so order is deterministic
      for (let j = 0; j < 10 - i; j++) refs.push(procRef(`P${i}`, "Sink"));
    }
    names.push("Sink");
    const res = globalRanking(mkIndex(refs, names), {
      rankBy: "outgoing",
      topN: 3,
      includeControl: false,
    });
    expect(res.ranking.length).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.ranking[0].process).toBe("P0");
    expect(res.ranking[0].outgoingCalls).toBe(10);
  });

  it("counts self-recursive calls", () => {
    const index = mkIndex([procRef("Loop", "Loop")], ["Loop"]);
    const res = globalRanking(index, {
      rankBy: "outgoing",
      topN: 50,
      includeControl: false,
    });
    const loop = res.ranking.find((r) => r.process === "Loop")!;
    expect(loop.outgoingCalls).toBe(1);
    expect(loop.incomingCalls).toBe(1);
  });
});

describe("buildCallGraph — includeControl", () => {
  const indexWithControlCall = () =>
    buildReferenceIndex({
      fetchProcesses: async () => [
        {
          name: "Parent",
          prolog:
            "ExecuteProcess('}bedrock.server.wait');\nExecuteProcess('Real');",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
        {
          name: "}bedrock.server.wait",
          prolog: "",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
        {
          name: "Real",
          prolog: "",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });

  it("hides '}' children by default and shows them with includeControl", async () => {
    const index = await indexWithControlCall();
    const hidden = buildCallGraph(index, "Parent", { direction: "downstream" });
    expect(hidden.children.map((c) => c.process)).toEqual(["Real"]);

    const shown = buildCallGraph(index, "Parent", {
      direction: "downstream",
      includeControl: true,
    });
    expect(shown.children.map((c) => c.process).sort()).toEqual(
      ["Real", "}bedrock.server.wait"].sort(),
    );
  });
});
