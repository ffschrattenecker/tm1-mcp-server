import { z } from "zod";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { dimensionCountMismatch } from "../../lib/coordinate-error.js";
import { resolveCellAddress } from "../../lib/cell-address.js";

export const registerWriteCells = defineTool({
  name: "tm1_write_cells",
  description: [
    "Write one or more cell values directly to a TM1 cube via REST.",
    "IMPORTANT: TI processes are the standard path for data loads — use this tool only for ad-hoc writes or when explicitly requested.",
    "Writes to consolidated cells are rejected by TM1.",
    "Every cube dimension must be named (any order) — a dimension left out would land on its default member, so the call is refused. Only Sandboxes may be left out: it is bound to Base and echoed as sandboxDefaulted. A named sandbox is addressable only once its IncludeInSandboxDimension is true.",
    "Before: tm1_check_writable_coords to validate that target coordinates are leaf-level and addressable.",
    "Related: tm1_clear_cube for bulk wipe, tm1_get_cell_value to read back, tm1_execute_process for production data loads.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    dimensions: z
      .array(z.string())
      .min(2)
      .describe(
        "Cube dimension names, any order; each cell's elements follow this order. Must cover every cube dimension except Sandboxes.",
      ),
    cells: z
      .array(
        z.object({
          elements: z
            .array(z.string())
            .describe(
              "Element names, one per entry in dimensions, in that order",
            ),
          value: z
            .union([z.number(), z.string()])
            .describe(
              "Cell value (number for Numeric cubes, string for String cells)",
            ),
        }),
      )
      .min(1)
      .describe("Cells to write"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, dimensions, cells, confirm }, tm1Client) => {
    // Overwrites prior cell values with no undo. Guards against an
    // auto-approve client firing this without intent — NOT a security
    // control: anything that can call the tool can also supply `confirm`.
    requireConfirm(confirm, cubeName, "cube");
    for (const c of cells) {
      if (c.elements.length !== dimensions.length) {
        throw dimensionCountMismatch(cubeName, dimensions, c.elements);
      }
    }
    // writeCells throws a TM1Error carrying its own partial-commit accounting
    // (written / failed / notAttempted) + a targeted hint, so we let it
    // propagate to the index.ts Proxy unwrapped — wrapping it here would
    // clobber that hint with a generic one.
    const address = resolveCellAddress(
      cubeName,
      await tm1Client.cubes.getDimensionNames(cubeName),
      dimensions,
    );
    await tm1Client.cells.writeCells(
      cubeName,
      address.dimensions,
      cells.map((c) => ({ ...c, elements: address.toCubeOrder(c.elements) })),
    );
    return actionResponse({
      success: true,
      cellsWritten: cells.length,
      ...(address.sandboxDefaulted
        ? { sandboxDefaulted: address.sandboxDefaulted }
        : {}),
    });
  },
});
