import { z } from "zod";
import {
  buildSampleCellsMdx,
  transformSampleCells,
  type SampleCellFilter,
} from "../../lib/sample-cells.js";
import { READ_ONLY } from "../annotations.js";
import { SampleCellsResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

const FilterValueSchema: z.ZodType<SampleCellFilter> = z.union([
  z.string(),
  z.array(z.string()).min(1),
]);

export const registerSampleCells = defineTool({
  name: "tm1_sample_cells",
  description: [
    "Return up to maxCells populated cells from a cube without guessing coordinates — builds a NON EMPTY CROSSJOIN MDX over the cube's dimensions and HEAD-limits it.",
    "For sanity-checks after a clone, finding non-zero cells, or debugging empty views. maxCells=0 means unlimited (WARNING: large cubes may return millions — filter first).",
    "NON EMPTY targets numeric cells; set includeStrings=true for String value fields.",
  ],
  annotations: READ_ONLY,
  output: SampleCellsResultSchema,
  input: {
    cubeName: z.string().describe("Cube to sample"),
    maxCells: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(5)
      .describe(
        "Max cells to return (default 5). 0 = no limit (unbounded; combine with filters).",
      ),
    filters: z
      .record(z.string(), FilterValueSchema)
      .optional()
      .describe(
        "Per-dimension filters. Single string → WHERE pin. Array of strings → axis member set. Keys must match cube dimension names.",
      ),
    axisDimension: z
      .string()
      .optional()
      .describe(
        "Dimension placed on COLUMNS (default: last dimension of the cube). Useful when the cube has a 'Measures'/'Account' dim that should drive columns.",
      ),
    leavesOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "If true (default), unfiltered dims are restricted to leaf members via TM1FILTERBYLEVEL([dim],0). Set false to include consolidations.",
      ),
    includeStrings: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Set true to sample String value fields. Swaps NON EMPTY for a `<> ""` FILTER and scans all members incl. consolidations (string values don\'t roll up, so they can sit on C). Requires the column/measure to resolve to a single element — pin it via filters or axisDimension.',
      ),
  },
  handler: async (
    { cubeName, maxCells, filters, axisDimension, leavesOnly, includeStrings },
    tm1Client,
  ) => {
    const startedAt = Date.now();
    const dimensions = await tm1Client.cubes.getDimensionNames(cubeName);

    // Sentinel row: ask TM1 for one cell MORE than requested, so `truncated`
    // is decided by evidence instead of inferred from a full page.
    // `cells.length >= maxCells` cannot tell "exactly maxCells cells exist"
    // apart from "more exist" and reported truncation for both. The extra row
    // is dropped below, so the response contract is unchanged.
    // maxCells=0 means unlimited — no sentinel, nothing to truncate.
    const requested = maxCells ?? 5;
    const built = buildSampleCellsMdx({
      cubeName,
      dimensions,
      maxCells: requested > 0 ? requested + 1 : 0,
      filters,
      axisDimension,
      leavesOnly: leavesOnly ?? true,
      includeStrings: includeStrings ?? false,
    });

    const result = await tm1Client.cells.executeMdx(built.mdx);

    const whereCoords: Record<string, string> = {};
    if (filters) {
      for (const [dim, val] of Object.entries(filters)) {
        if (typeof val === "string") whereCoords[dim] = val;
      }
    }
    const sampled = transformSampleCells({ result, whereCoords });
    const truncated = requested > 0 && sampled.length > requested;
    const cells = truncated ? sampled.slice(0, requested) : sampled;

    const hint =
      cells.length === 0
        ? includeStrings
          ? "No populated cells found — cube may be empty or current filters exclude data."
          : "No populated cells found — cube may be empty, all-consolidated, or current filters exclude data. If the value field is a String type, NON EMPTY cannot detect it: retry with includeStrings=true."
        : undefined;

    const elapsedMs = Date.now() - startedAt;

    const payload = {
      cubeName,
      count: cells.length,
      truncated,
      cells,
      filtersApplied: filters ?? {},
      axisDimension: built.columnDim,
      rowDims: built.rowDims,
      whereDims: built.whereDims,
      mdxUsed: built.mdx,
      elapsedMs,
      ...(hint ? { hint } : {}),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
