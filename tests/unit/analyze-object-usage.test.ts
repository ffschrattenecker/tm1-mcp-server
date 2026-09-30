import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { TM1Client } from "../../src/tm1-client.js";

// The impact check before deleting a cube or dimension: what
// tm1_analyze_object_usage mode='summary' returns, plus usedInCubes for a
// dimension.
vi.mock("../../src/lib/callgraph/tm1-adapter.js", () => ({
  buildIndexFromTM1: async () => ({}),
  invalidateCallgraphCache: () => ({ cleared: 0 }),
}));
vi.mock("../../src/lib/callgraph/callGraph.js", () => ({
  buildCubeOrDimUsages: (_i: unknown, _k: string, name: string) =>
    name === "Region"
      ? [
          {
            sourceKind: "process",
            sourceName: "IMP.Load",
            accessType: "read",
            section: "data",
            funcName: "CellGetN",
          },
          {
            sourceKind: "process",
            sourceName: "IMP.Load",
            accessType: "write",
            section: "data",
            funcName: "CellPutN",
          },
          {
            sourceKind: "rule",
            sourceName: "Sales",
            accessType: "read",
            section: "rules",
          },
        ]
      : [],
}));

const { registerAnalyzeObjectUsage } =
  await import("../../src/tools/analysis/analyze-object-usage.js");

function setup() {
  let cubeListCalls = 0;
  const client = {
    cubes: {
      list: async () => {
        cubeListCalls++;
        return [
          { name: "Sales", dimensions: ["region", "Month"] },
          { name: "HR", dimensions: ["Employee"] },
          { name: "}ElementAttributes_Region", dimensions: ["Region"] },
        ];
      },
    },
  } as unknown as TM1Client;
  let h: ((a: unknown) => Promise<unknown>) | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  registerAnalyzeObjectUsage(
    {
      tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
        parser = z.object(s);
        h = cb;
      },
    } as never,
    client,
  );
  const call = (args: Record<string, unknown>) =>
    (
      h!(parser!.parse(args)) as Promise<{ content: Array<{ text: string }> }>
    ).then((r) => ({
      // The server proxy turns the JSON text into structuredContent; the bare
      // handler only returns the text.
      structuredContent: JSON.parse(r.content[0].text) as Record<
        string,
        unknown
      >,
    }));
  return { call, cubeListCalls: () => cubeListCalls };
}

describe("tm1_analyze_object_usage delete impact", () => {
  it("summary for a dimension lists the cubes using it and the referencing sources", async () => {
    const { call } = setup();
    const res = await call({
      kind: "dimension",
      objectName: "Region",
      mode: "summary",
    });
    expect(res.structuredContent).toMatchObject({
      kind: "dimension",
      usedInCubes: ["Sales"],
      count: 3,
      sourceCount: 2,
      truncated: false,
      sources: [
        {
          sourceKind: "process",
          sourceName: "IMP.Load",
          accessTypes: ["read", "write"],
          count: 2,
        },
        { sourceKind: "rule", sourceName: "Sales", count: 1 },
      ],
    });
  });

  it("full mode carries usedInCubes too", async () => {
    const { call } = setup();
    const res = await call({ kind: "dimension", objectName: "Region" });
    expect(res.structuredContent.usedInCubes).toEqual(["Sales"]);
    expect(res.structuredContent.count).toBe(3);
  });

  it("includeSystem keeps control cubes in usedInCubes", async () => {
    const { call } = setup();
    const res = await call({
      kind: "dimension",
      objectName: "Region",
      includeSystem: true,
    });
    expect(res.structuredContent.usedInCubes).toEqual([
      "Sales",
      "}ElementAttributes_Region",
    ]);
  });

  it("an unreferenced cube reports no sources, no usedInCubes, and lists no cubes", async () => {
    const { call, cubeListCalls } = setup();
    const res = await call({ kind: "cube", objectName: "HR", mode: "summary" });
    expect(res.structuredContent).toMatchObject({
      count: 0,
      sourceCount: 0,
      sources: [],
    });
    expect(res.structuredContent).not.toHaveProperty("usedInCubes");
    expect(cubeListCalls()).toBe(0);
  });
});
