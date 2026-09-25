import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { TM1Client } from "../../src/tm1-client.js";

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

const { registerDeleteDimension } =
  await import("../../src/tools/dimension-management/delete-dimension.js");
const { registerDeleteCube } =
  await import("../../src/tools/model-building/delete-cube.js");

function setup(register: typeof registerDeleteDimension) {
  const deleted: string[] = [];
  const client = {
    cubes: {
      list: async () => [
        { name: "Sales", dimensions: ["region", "Month"] },
        { name: "HR", dimensions: ["Employee"] },
      ],
      delete: async (n: string) => void deleted.push(n),
    },
    dimensions: { delete: async (n: string) => void deleted.push(n) },
  } as unknown as TM1Client;
  let h: ((a: unknown) => Promise<unknown>) | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  register(
    {
      tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
        parser = z.object(s);
        h = cb;
      },
    } as never,
    client,
  );
  const call = (args: Record<string, unknown>) =>
    h!(parser!.parse(args)) as Promise<{
      structuredContent: Record<string, unknown>;
    }>;
  return { call, deleted };
}

describe("delete dryRun", () => {
  it("delete_dimension lists cubes and references without confirm, deleting nothing", async () => {
    const { call, deleted } = setup(registerDeleteDimension);
    const res = await call({ dimensionName: "Region", dryRun: true });
    expect(res.structuredContent).toMatchObject({
      dryRun: true,
      needsConfirm: "Region",
      impact: {
        usedInCubes: ["Sales"],
        referencingSources: 2,
        sources: [
          {
            sourceKind: "process",
            sourceName: "IMP.Load",
            accessTypes: ["read", "write"],
            count: 2,
          },
          { sourceKind: "rule", sourceName: "Sales", count: 1 },
        ],
      },
    });
    expect(deleted).toEqual([]);
  });

  it("a dryRun is not a confirmation", async () => {
    const { call, deleted } = setup(registerDeleteDimension);
    await call({ dimensionName: "Region", dryRun: true });
    await expect(call({ dimensionName: "Region" })).rejects.toThrow();
    expect(deleted).toEqual([]);
  });

  it("delete_cube reports an unreferenced cube as such", async () => {
    const { call, deleted } = setup(registerDeleteCube);
    const res = await call({ cubeName: "HR", dryRun: true });
    expect(res.structuredContent.impact).toEqual({
      referencingSources: 0,
      sources: [],
    });
    expect(deleted).toEqual([]);
  });
});
