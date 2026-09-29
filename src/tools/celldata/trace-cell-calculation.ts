import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { CalculationTraceResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import type { CalculationTraceNode } from "../../types.js";

export const registerTraceCellCalculation = defineTool({
  name: "tm1_trace_cell_calculation",
  description: [
    "Trace how a cell value is calculated: recursive component tree with per-component type (Consolidation/Rule/Simple), status (Null/Data/Error), value, and the rule statements that populate it — answers 'why is this cell X / empty?'.",
    "The tree is truncated client-side via maxDepth/maxComponents; truncated=true marks cut branches (re-run with the branch tuple as new start cell to drill deeper).",
    "Rule statements are listed once in statementTable; each node's statementRefs index into it (a long rule would otherwise repeat on every node). dedupeStatements=false restores per-node statements.",
    "Elements are given in cube dimension order (discover with tm1_list_cubes). Write Hierarchy:Element for an alternate hierarchy; the first colon splits, so in dimension Region 'Region:A:B' is element 'A:B' of the default one.",
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
    dedupeStatements: z
      .boolean()
      .optional()
      .describe(
        "List each rule statement once in statementTable and reference it by index (default true).",
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
    {
      cubeName,
      elements,
      maxDepth,
      maxComponents,
      dedupeStatements,
      timeoutMs,
    },
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
    const out = dedupeStatements === false ? tree : withStatementTable(tree);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(out) }],
    };
  },
});

type DedupedNode = Omit<CalculationTraceNode, "statements" | "components"> & {
  statementRefs?: number[];
  components?: DedupedNode[];
};

// Move every node's statements into one table on the root and leave indexes
// behind. TM1 repeats the full rule text on each node it evaluated, so a trace
// over one quarter of a rule-heavy cube was mostly the same statement.
function withStatementTable(
  root: CalculationTraceNode,
): DedupedNode & { statementTable?: string[] } {
  const table: string[] = [];
  const index = new Map<string, number>();
  const walk = (node: CalculationTraceNode): DedupedNode => {
    const { statements, components, ...rest } = node;
    const out: DedupedNode = { ...rest };
    if (statements && statements.length > 0) {
      out.statementRefs = statements.map((st) => {
        let i = index.get(st);
        if (i === undefined) {
          i = table.length;
          table.push(st);
          index.set(st, i);
        }
        return i;
      });
    }
    if (components) out.components = components.map(walk);
    return out;
  };
  const deduped = walk(root);
  return table.length > 0 ? { ...deduped, statementTable: table } : deduped;
}
