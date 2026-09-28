import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { CheckFeedersResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCheckFeeders = defineTool({
  name: "tm1_check_feeders",
  description: [
    "Check the feeders of a cell: verifies feeder coverage for the cells underlying this cell and returns the problematic ones with a fed flag — fed=false marks a broken or missing feeder (the classic cause of empty consolidated/rule cells). An empty result means no feeder problems were detected (live-verified on 11.8: fully-fed areas return []).",
    "Per-cell runtime check; complements tm1_audit_feeders (static rule analysis).",
    "Elements are given in cube dimension order (discover with tm1_list_cubes). A bare name addresses the dimension's default hierarchy; write Hierarchy:Element for an alternate one. The split takes the first colon, so an element whose own name contains one is reached by naming its hierarchy: in dimension Region, 'Region:A:B' is element 'A:B' in the default hierarchy.",
    "Related: tm1_trace_feeders (statements involved), tm1_trace_cell_calculation (why has this cell value X).",
  ],
  annotations: READ_ONLY,
  output: CheckFeedersResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    elements: z
      .array(z.string())
      .describe(
        "Element names for each dimension of the cube, in cube dimension order. Prefix with a hierarchy to leave the default one: 'AltHier:Elem'.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override the default request timeout (ms, 1000–3600000). Checks over deep consolidations can be slow.",
      ),
  },
  handler: async ({ cubeName, elements, timeoutMs }, tm1Client, extra) => {
    const fedCells = await withToolHint(
      tm1Client.cells.checkFeeders(cubeName, elements, {
        signal: extra?.signal,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
      `CheckFeeders failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes.`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              count: fedCells.length,
              unfedCount: fedCells.filter((c) => !c.fed).length,
              fedCells,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
