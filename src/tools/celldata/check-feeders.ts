import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { CheckFeedersResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import type { CellProbe } from "../../types.js";

// Unfed leaves listed in the response; the counts cover all of them.
const UNFED_LISTED = 50;

interface LeafCheck {
  checked: number;
  total: number;
  truncated: boolean;
  unfedCount: number;
  unfedValue: number;
  unfed: Array<{ tuple: string[]; value: CellProbe["value"] }>;
}

export const registerCheckFeeders = defineTool({
  name: "tm1_check_feeders",
  description: [
    "Check the feeders of a cell: TM1's CheckFeeders walks the cells underlying this cell and returns problematic ones with a fed flag — fed=false marks a broken or missing feeder (the classic cause of consolidations that miss rule-calculated leaves).",
    "An empty fedCells is NOT proof of full feeding: TM1 has returned [] for consolidations with unfed leaves. conclusive=false says so; pass verifyLeaves=true for a check that does not rely on CheckFeeders — every leaf under the cell is read plain and under NON EMPTY, and a leaf with a value that NON EMPTY drops is unfed (leafCheck).",
    "target reports the start cell's live state (value, ruleDerived, consolidated, fed; fed is null for a consolidation, which survives NON EMPTY once any leaf is fed).",
    "Elements are given in cube dimension order (discover with tm1_list_cubes). Write Hierarchy:Element for an alternate hierarchy; the first colon splits, so in dimension Region 'Region:A:B' is element 'A:B' of the default one.",
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
    verifyLeaves: z
      .boolean()
      .optional()
      .describe(
        "Also read every leaf under the cell plain and under NON EMPTY; a leaf with a value that NON EMPTY drops is unfed. Default false.",
      ),
    maxCells: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        "Cap on leaf cells read by verifyLeaves (default 500); leafCheck.truncated marks a partial check.",
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
  handler: async (
    { cubeName, elements, verifyLeaves, maxCells, timeoutMs },
    tm1Client,
    extra,
  ) => {
    const opts = {
      signal: extra?.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    const fedCells = await withToolHint(
      tm1Client.cells.checkFeeders(cubeName, elements, opts),
      `CheckFeeders failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes.`,
    );
    const unfedCount = fedCells.filter((c) => !c.fed).length;

    // The cell's own state is extra; if it cannot be read, TM1's answer stands.
    let target: CellProbe | undefined;
    try {
      [target] = await tm1Client.cells.probeCells(cubeName, [elements], opts);
    } catch {
      target = undefined;
    }

    let leafCheck: LeafCheck | undefined;
    if (verifyLeaves) {
      const leaves = await withToolHint(
        tm1Client.cells.leafTuples(cubeName, elements, maxCells ?? 500, opts),
        `Expanding the leaves under the cell of cube '${cubeName}' failed.`,
      );
      const probes = await withToolHint(
        tm1Client.cells.probeCells(cubeName, leaves.tuples, opts),
        `Reading the leaves under the cell of cube '${cubeName}' failed.`,
      );
      const unfed = probes.filter((p) => p.fed === false);
      leafCheck = {
        checked: probes.length,
        total: leaves.total,
        truncated: leaves.truncated,
        unfedCount: unfed.length,
        unfedValue: unfed.reduce(
          (n, p) => n + (typeof p.value === "number" ? p.value : 0),
          0,
        ),
        unfed: unfed
          .slice(0, UNFED_LISTED)
          .map((p) => ({ tuple: p.tuple, value: p.value })),
      };
    }

    const conclusive = leafCheck ? !leafCheck.truncated : unfedCount > 0;
    const warning = warningFor(unfedCount, target, leafCheck);
    const unread = target
      ? undefined
      : "The cell's live state could not be read; target is omitted.";

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              count: fedCells.length,
              unfedCount,
              fedCells,
              conclusive,
              ...(warning || unread
                ? { warning: [warning, unread].filter(Boolean).join(" ") }
                : {}),
              ...(target ? { target: probeState(target) } : {}),
              ...(leafCheck ? { leafCheck } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});

// A consolidation survives NON EMPTY as soon as one leaf is fed, so its fed
// state says nothing about full feeding — report it as unknown.
export function probeState(p: CellProbe) {
  return {
    value: p.value,
    ruleDerived: p.ruleDerived,
    consolidated: p.consolidated,
    fed: p.consolidated ? null : p.fed,
  };
}

function warningFor(
  unfedCount: number,
  target: CellProbe | undefined,
  leafCheck: LeafCheck | undefined,
): string | undefined {
  const parts: string[] = [];
  if (target && !target.consolidated && target.fed === false) {
    parts.push(
      "The cell itself holds a value but is unfed: NON EMPTY drops it and consolidations above it skip it.",
    );
  }
  if (leafCheck) {
    if (leafCheck.unfedCount > 0 && unfedCount === 0) {
      parts.push(
        `CheckFeeders reported nothing, but ${leafCheck.unfedCount} leaf cell(s) hold a value that NON EMPTY drops — they are unfed (see leafCheck.unfed).`,
      );
    }
    if (leafCheck.truncated) {
      parts.push(
        `The leaf check covered ${leafCheck.checked} of ${leafCheck.total} cells; narrow the coordinate or raise maxCells.`,
      );
    }
  } else if (unfedCount === 0) {
    parts.push(
      "An empty result is not proof of full feeding. Re-run with verifyLeaves=true to check the leaves directly.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
