import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerTraceCellCalculation } from "../../src/tools/celldata/trace-cell-calculation.js";
import type { TM1Client } from "../../src/tm1-client.js";

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

const run = async (h: ToolHandler, args: Record<string, unknown>) =>
  JSON.parse((await h(args)).content[0].text);

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
