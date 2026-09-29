import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerCheckFeeders } from "../../src/tools/celldata/check-feeders.js";
import { registerTraceFeeders } from "../../src/tools/celldata/trace-feeders.js";
import { registerTraceCellCalculation } from "../../src/tools/celldata/trace-cell-calculation.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { CellProbe } from "../../src/types.js";

// The case these tools exist for: Q3 of A_4 is a native consolidation over
// 07..09, and 09 is rule-calculated with a value but unfed, so Q3 misses it.
// TM1's own answers are stubbed as observed: CheckFeeders may come back empty,
// TraceFeeders flags the target fed=true either way.

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function capture(
  register: (server: never, client: TM1Client) => void,
  client: TM1Client,
): ToolHandler {
  let handler: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: ToolHandler) => {
      parser = z.object(schema);
      handler = h;
    },
  };
  register(server as never, client);
  return (args) => handler!(parser!.parse(args));
}

const probe = (
  tuple: string[],
  value: CellProbe["value"],
  fed: boolean | null,
  consolidated = false,
): CellProbe => ({
  tuple,
  value,
  ruleDerived: !consolidated,
  consolidated,
  fed,
});

const leafState: Record<string, CellProbe> = {
  "07": probe(["07", "A_4", "Qty"], 1, true),
  "08": probe(["08", "A_4", "Qty"], 2, true),
  "09": probe(["09", "A_4", "Qty"], 3, false),
};

function fakeClient(checkFeeders: CellProbe[] | []) {
  const cells = {
    checkFeeders: vi.fn().mockResolvedValue(checkFeeders),
    traceFeeders: vi.fn().mockResolvedValue({
      fedCells: [{ cube: "C", tuple: ["09", "A_4", "Qty"], fed: true }],
      statements: ["['Qty','A_3'] => ['Qty','A_4'];"],
    }),
    leafTuples: vi.fn().mockResolvedValue({
      tuples: [
        ["07", "A_4", "Qty"],
        ["08", "A_4", "Qty"],
        ["09", "A_4", "Qty"],
      ],
      total: 3,
      truncated: false,
    }),
    probeCells: vi.fn(async (_cube: string, tuples: string[][]) =>
      tuples.map((t) =>
        t[0] === "Q3"
          ? probe(t, 3, true, true)
          : t[1] === "A_3"
            ? probe(t, 3, false)
            : leafState[t[0]],
      ),
    ),
  };
  return { client: { cells } as unknown as TM1Client, cells };
}

const run = async (h: ToolHandler, args: Record<string, unknown>) =>
  JSON.parse((await h(args)).content[0].text);

describe("tm1_check_feeders", () => {
  it("marks an empty CheckFeeders result inconclusive and points at verifyLeaves", async () => {
    const { client, cells } = fakeClient([]);
    const out = await run(capture(registerCheckFeeders, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
    });

    expect(out.count).toBe(0);
    expect(out.conclusive).toBe(false);
    expect(out.warning).toMatch(/verifyLeaves=true/);
    // A consolidation survives NON EMPTY once any leaf is fed: unknown, not true.
    expect(out.target).toEqual({
      value: 3,
      ruleDerived: false,
      consolidated: true,
      fed: null,
    });
    expect(out.leafCheck).toBeUndefined();
    expect(cells.leafTuples).not.toHaveBeenCalled();
  });

  it("verifyLeaves finds the unfed leaf CheckFeeders missed", async () => {
    const { client, cells } = fakeClient([]);
    const out = await run(capture(registerCheckFeeders, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
      verifyLeaves: true,
      maxCells: 50,
    });

    expect(cells.leafTuples).toHaveBeenCalledWith(
      "C",
      ["Q3", "A_4", "Qty"],
      50,
      expect.anything(),
    );
    expect(out.conclusive).toBe(true);
    expect(out.leafCheck).toMatchObject({
      checked: 3,
      total: 3,
      truncated: false,
      unfedCount: 1,
      unfedValue: 3,
      unfed: [{ tuple: ["09", "A_4", "Qty"], value: 3 }],
    });
    expect(out.warning).toMatch(/CheckFeeders reported nothing, but 1 leaf/);
  });

  it("a truncated leaf check is not conclusive", async () => {
    const { client, cells } = fakeClient([]);
    cells.leafTuples.mockResolvedValue({
      tuples: [["07", "A_4", "Qty"]],
      total: 3,
      truncated: true,
    });
    const out = await run(capture(registerCheckFeeders, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
      verifyLeaves: true,
      maxCells: 1,
    });

    expect(out.conclusive).toBe(false);
    expect(out.warning).toMatch(/covered 1 of 3 cells/);
  });

  it("keeps TM1's findings and calls a reported problem conclusive", async () => {
    const reported = [{ cube: "C", tuple: ["09", "A_4", "Qty"], fed: false }];
    const { client } = fakeClient(reported as never);
    const out = await run(capture(registerCheckFeeders, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
    });

    expect(out.fedCells).toEqual(reported);
    expect(out.unfedCount).toBe(1);
    expect(out.conclusive).toBe(true);
    expect(out.warning).toBeUndefined();
  });

  it("flags an unfed leaf start cell", async () => {
    const { client } = fakeClient([]);
    const out = await run(capture(registerCheckFeeders, client), {
      cubeName: "C",
      elements: ["09", "A_4", "Qty"],
    });

    expect(out.target.fed).toBe(false);
    expect(out.warning).toMatch(/cell itself holds a value but is unfed/);
  });
});

describe("tm1_trace_feeders", () => {
  it("reports an unfed rule-calculated source whose feeders cannot fire", async () => {
    const { client } = fakeClient([]);
    const out = await run(capture(registerTraceFeeders, client), {
      cubeName: "C",
      elements: ["09", "A_3", "Qty"],
    });

    expect(out.count).toBe(1);
    expect(out.fedCells[0].fed).toBe(true);
    expect(out.fedCells[0].liveFed).toBeUndefined();
    expect(out.source).toEqual({
      value: 3,
      ruleDerived: true,
      consolidated: false,
      fed: false,
    });
    expect(out.warning).toMatch(
      /NOT fed, so its feeder statements do not fire/,
    );
  });

  it("verifyTargets reads the target back: fed=true but liveFed=false", async () => {
    const { client, cells } = fakeClient([]);
    const out = await run(capture(registerTraceFeeders, client), {
      cubeName: "C",
      elements: ["09", "A_3", "Qty"],
      verifyTargets: true,
    });

    expect(cells.probeCells).toHaveBeenLastCalledWith(
      "C",
      [["09", "A_4", "Qty"]],
      expect.anything(),
    );
    expect(out.fedCells[0]).toMatchObject({ fed: true, liveFed: false });
    expect(out.warning).toMatch(/1 target\(s\) hold a value but are not fed/);
  });

  it("a failing target probe leaves liveFed unset instead of failing the trace", async () => {
    const { client, cells } = fakeClient([]);
    cells.probeCells
      .mockImplementationOnce(async (_c: string, t: string[][]) => [
        probe(t[0], 1, true),
      ])
      .mockRejectedValueOnce(new Error("no such cube"));
    const out = await run(capture(registerTraceFeeders, client), {
      cubeName: "C",
      elements: ["07", "A_3", "Qty"],
      verifyTargets: true,
    });

    expect(out.fedCells[0].liveFed).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });

  it("returns TM1's answer when the cell's own state cannot be read", async () => {
    const reported = [{ cube: "C", tuple: ["09", "A_4", "Qty"], fed: false }];
    const { client, cells } = fakeClient(reported as never);
    cells.probeCells.mockRejectedValueOnce(new Error("read refused"));
    const out = await run(capture(registerCheckFeeders, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
    });

    expect(out.fedCells).toEqual(reported);
    expect(out.target).toBeUndefined();
    expect(out.warning).toMatch(/could not be read/);
  });
});

describe("tm1_trace_cell_calculation", () => {
  const rule = "['Qty','A_4'] = N: ['Qty','A_3'];";
  const tree = {
    type: "Consolidation",
    value: 3,
    tuple: ["Q3", "A_4", "Qty"],
    components: [
      {
        type: "Rule",
        value: 1,
        tuple: ["07", "A_4", "Qty"],
        statements: [rule],
      },
      {
        type: "Rule",
        value: 2,
        tuple: ["08", "A_4", "Qty"],
        statements: [rule],
      },
      { type: "Simple", value: 5, tuple: ["07", "A_4", "Src"] },
    ],
  };
  const client = {
    cells: { traceCellCalculation: vi.fn().mockResolvedValue(tree) },
  } as unknown as TM1Client;

  it("lists each statement once and references it by index", async () => {
    const out = await run(capture(registerTraceCellCalculation, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
    });

    expect(out.statementTable).toEqual([rule]);
    expect(out.components[0]).toMatchObject({ statementRefs: [0] });
    expect(out.components[1]).toMatchObject({ statementRefs: [0] });
    expect(out.components[0].statements).toBeUndefined();
    expect(out.components[2].statementRefs).toBeUndefined();
  });

  it("dedupeStatements=false keeps TM1's per-node statements", async () => {
    const out = await run(capture(registerTraceCellCalculation, client), {
      cubeName: "C",
      elements: ["Q3", "A_4", "Qty"],
      dedupeStatements: false,
    });

    expect(out).toEqual(tree);
  });
});
