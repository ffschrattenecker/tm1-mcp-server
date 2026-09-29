import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { READ_ONLY } from "../annotations.js";
import { TraceFeedersResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import type { CellProbe, FedCellDescriptor } from "../../types.js";

// Targets read back by verifyTargets; the rest keep liveFed unset.
const MAX_VERIFIED = 100;

export const registerTraceFeeders = defineTool({
  name: "tm1_trace_feeders",
  description: [
    "Trace the feeders of a cell: returns the cells this cell's feeder statements point at plus the statements — answers 'which feeder statements apply to this cell and where do they point'.",
    "fedCells[].fed is TM1's flag on the statement target, NOT the target's live state: it has been true for targets that were not fed. It also does not say whether the feeder fires — a rule-calculated source only fires its feeders once it is fed itself.",
    "source reports the traced cell's live state (value, ruleDerived, consolidated, fed: null = empty/zero, unknowable); warning flags an unfed rule-calculated source. verifyTargets=true reads each target back and sets fedCells[].liveFed (null for consolidated or empty targets).",
    "Use when a rule cell stays empty under SKIPCHECK: trace the source cell to see where its feeder points, then check source.fed and liveFed.",
    "Elements are given in cube dimension order (discover with tm1_list_cubes). Write Hierarchy:Element for an alternate hierarchy; the first colon splits, so in dimension Region 'Region:A:B' is element 'A:B' of the default one.",
    "Related: tm1_check_feeders (fed/unfed flags, verifyLeaves), tm1_audit_feeders (static analysis).",
  ],
  annotations: READ_ONLY,
  output: TraceFeedersResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    elements: z
      .array(z.string())
      .describe(
        "Element names for each dimension of the cube, in cube dimension order. Prefix with a hierarchy to leave the default one: 'AltHier:Elem'.",
      ),
    verifyTargets: z
      .boolean()
      .optional()
      .describe(
        `Read each target back (plain + NON EMPTY) and set fedCells[].liveFed. Up to ${MAX_VERIFIED} targets. Default false.`,
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
    { cubeName, elements, verifyTargets, timeoutMs },
    tm1Client,
    extra,
  ) => {
    const opts = {
      signal: extra?.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    const result = await withToolHint(
      tm1Client.cells.traceFeeders(cubeName, elements, opts),
      `TraceFeeders failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes.`,
    );
    const [source] = await withToolHint(
      tm1Client.cells.probeCells(cubeName, [elements], opts),
      `Reading the cell of cube '${cubeName}' failed after TraceFeeders succeeded.`,
    );

    let fedCells: Array<FedCellDescriptor & { liveFed?: boolean | null }> =
      result.fedCells;
    if (verifyTargets) {
      fedCells = await withLiveFed(result.fedCells, (cube, tuples) =>
        tm1Client.cells.probeCells(cube, tuples, opts),
      );
    }
    const warning = warningFor(source, fedCells);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: result.fedCells.length,
            fedCells,
            statements: result.statements,
            ...(source
              ? {
                  source: {
                    value: source.value,
                    ruleDerived: source.ruleDerived,
                    consolidated: source.consolidated,
                    fed: source.fed,
                  },
                }
              : {}),
            ...(warning ? { warning } : {}),
          }),
        },
      ],
    };
  },
});

// Probe the first MAX_VERIFIED targets, one batch per target cube. A cube
// whose probe fails leaves its targets without liveFed rather than failing
// the whole trace.
async function withLiveFed(
  cells: FedCellDescriptor[],
  probe: (cube: string, tuples: string[][]) => Promise<CellProbe[]>,
): Promise<Array<FedCellDescriptor & { liveFed?: boolean | null }>> {
  const out: Array<FedCellDescriptor & { liveFed?: boolean | null }> =
    cells.map((c) => ({ ...c }));
  const byCube = new Map<string, number[]>();
  out.slice(0, MAX_VERIFIED).forEach((c, i) => {
    const list = byCube.get(c.cube) ?? [];
    list.push(i);
    byCube.set(c.cube, list);
  });
  for (const [cube, idx] of byCube) {
    let probes: CellProbe[];
    try {
      probes = await probe(
        cube,
        idx.map((i) => out[i]!.tuple),
      );
    } catch {
      continue;
    }
    idx.forEach((i, k) => {
      const p = probes[k]!;
      out[i]!.liveFed = p.consolidated ? null : p.fed;
    });
  }
  return out;
}

function warningFor(
  source: CellProbe | undefined,
  fedCells: Array<{ liveFed?: boolean | null }>,
): string | undefined {
  const parts: string[] = [];
  if (source?.ruleDerived && !source.consolidated) {
    if (source.fed === false) {
      parts.push(
        "The traced cell is rule-calculated and NOT fed, so its feeder statements do not fire — trace what should feed this cell.",
      );
    } else if (source.fed === null) {
      parts.push(
        "The traced cell is rule-calculated and empty; its feeders fire only once it is fed, which an empty cell cannot show.",
      );
    }
  }
  const unfedTargets = fedCells.filter((c) => c.liveFed === false).length;
  if (unfedTargets > 0) {
    parts.push(
      `${unfedTargets} target(s) hold a value but are not fed (liveFed=false), whatever fed says.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
