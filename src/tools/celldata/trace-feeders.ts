import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { READ_ONLY } from "../annotations.js";
import { TraceFeedersResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { COORD_ELEMENTS_DESCRIPTION } from "./member-ref.js";

export const registerTraceFeeders = defineTool({
  name: "tm1_trace_feeders",
  description: [
    "Trace the feeders of a cell: returns the cells this cell feeds plus the feeder statements involved — answers 'which feeder statement fires from this cell, and where to'.",
    "Use when a rule cell stays empty under SKIPCHECK: trace the source cell to see whether its feeder reaches the target.",
    "Related: tm1_check_feeders (fed/unfed flags), tm1_audit_feeders (static analysis).",
  ],
  annotations: READ_ONLY,
  output: TraceFeedersResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    elements: z.array(z.string()).describe(COORD_ELEMENTS_DESCRIPTION),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override the default request timeout (ms, 1000–3600000). Traces over deep consolidations can be slow.",
      ),
  },
  handler: async ({ cubeName, elements, timeoutMs }, tm1Client, extra) => {
    const result = await withToolHint(
      tm1Client.cells.traceFeeders(cubeName, elements, {
        signal: extra?.signal,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
      `TraceFeeders failed for cube '${cubeName}'. Verify dimension order/elements via tm1_rest_read Cubes('${cubeName}')/Dimensions?$select=Name.`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ count: result.fedCells.length, ...result }),
        },
      ],
    };
  },
});
