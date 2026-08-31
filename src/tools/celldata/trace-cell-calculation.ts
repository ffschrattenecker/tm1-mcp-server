import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { CalculationTraceResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerTraceCellCalculation = defineTool({
  name: "tm1_trace_cell_calculation",
  description: [
    "Trace how a cell value is calculated: recursive component tree with per-component type (Consolidation/Rule/Simple), status (Null/Data/Error), value, and the rule statements that populate it — answers 'why is this cell X / empty?'.",
    "The tree is truncated client-side via maxDepth/maxComponents; truncated=true marks cut branches (re-run with the branch tuple as new start cell to drill deeper).",
    "Elements are given in cube dimension order (discover with tm1_list_cubes). A bare name addresses the dimension's default hierarchy; write Hierarchy:Element for an alternate one. The split takes the first colon, so an element whose own name contains one is reached by naming its hierarchy: in dimension Region, 'Region:A:B' is element 'A:B' in the default hierarchy.",
    "Related: tm1_check_feeders / tm1_trace_feeders for feeder issues, tm1_get_cube_rules for the full rule text.",
  ],
  annotations: READ_ONLY,
  output: CalculationTraceResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    elements: z
      .array(z.string())
      .describe(
        "Element names for each dimension of the cube, in cube dimension order. Prefix with a hierarchy to leave the default one: 'AltHier:Elem'.",
      ),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(
        "Maximum component-tree depth to return (default 3). Deep consolidations explode quickly.",
      ),
    maxComponents: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Maximum components per node (default 20). Excess children are dropped and the node marked truncated.",
      ),
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
  handler: async (
    { cubeName, elements, maxDepth, maxComponents, timeoutMs },
    tm1Client,
    extra,
  ) => {
    const tree = await withToolHint(
      tm1Client.cells.traceCellCalculation(
        cubeName,
        elements,
        maxDepth,
        maxComponents,
        {
          signal: extra?.signal,
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      ),
      `TraceCellCalculation failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes.`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(tree) }],
    };
  },
});
