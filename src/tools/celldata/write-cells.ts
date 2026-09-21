import { z } from "zod";
import { TM1Error } from "../../types.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

/**
 * Split a bracketed MDX reference into its parts, `]]` unescaped back to `]`.
 *
 * Hand-parsed rather than matched: a regex over `[^\]]+` cannot see past an
 * escaped `]]`, so every name containing a `]` would fall out of the guard
 * and be written unchecked.
 *
 * Returns null for anything that is not a well-formed bracketed reference —
 * the caller then treats the string as a bare element name, which is what the
 * writer does with it too.
 */
function mdxParts(ref: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  while (i < ref.length) {
    if (ref[i] !== "[") return null;
    i++;
    let name = "";
    for (;;) {
      if (i >= ref.length) return null;
      if (ref[i] === "]") {
        if (ref[i + 1] === "]") {
          name += "]";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      name += ref[i]!;
      i++;
    }
    parts.push(name);
    if (i === ref.length) return parts;
    if (ref[i] !== ".") return null;
    i++;
  }
  return null;
}

/**
 * Where an element reference points, in the four shapes cell-service's
 * `qualifyWriteMember` accepts: a bare name, `[Element]`,
 * `[Dimension].[Element]` (default hierarchy) and the fully qualified
 * `[Dimension].[Hierarchy].[Element]`.
 *
 * Both sides must read a reference the same way. Where this function and the
 * writer disagree, the guard probes one coordinate and the write hits another.
 */
function memberRef(
  dimension: string,
  element: string,
): { dimension: string; hierarchy: string; element: string } {
  const parts = element.startsWith("[") ? mdxParts(element) : null;
  if (parts?.length === 3) {
    return { dimension: parts[0]!, hierarchy: parts[1]!, element: parts[2]! };
  }
  if (parts?.length === 2) {
    return { dimension: parts[0]!, hierarchy: parts[0]!, element: parts[1]! };
  }
  return {
    dimension,
    hierarchy: dimension,
    element: parts?.length === 1 ? parts[0]! : element,
  };
}

export const registerWriteCells = defineTool({
  name: "tm1_write_cells",
  description: [
    "Write one or more cell values directly to a TM1 cube via REST.",
    "IMPORTANT: TI processes are the standard path for data loads — use this tool only for ad-hoc writes or when explicitly requested.",
    "Leaf (N-level) coordinates only. Every coordinate is checked before anything is sent and a consolidated one aborts the whole call: writing to a C element is not how TM1 data is loaded, and whether the server would even accept it depends on the account's rights. Aggregate values come from the consolidation, not from a write.",
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
        "Cube dimension names in exact cube order (required because the element tuples use @odata.bind references)",
      ),
    cells: z
      .array(
        z.object({
          elements: z
            .array(z.string())
            .describe(
              "Element names, one per dimension, in the cube's dimension order",
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
        throw new TM1Error({
          code: "VALIDATION_ERROR",
          message: `Cell element count (${c.elements.length}) does not match dimension count (${dimensions.length})`,
        });
      }
    }

    // One probe per distinct hierarchy, not per cell: a write typically
    // reuses the same handful of elements across many coordinates.
    const byHierarchy = new Map<
      string,
      { dimension: string; hierarchy: string; names: Set<string> }
    >();
    for (const c of cells) {
      c.elements.forEach((e, idx) => {
        const ref = memberRef(dimensions[idx]!, e);
        const key = `${ref.dimension}\u0000${ref.hierarchy}`;
        const entry = byHierarchy.get(key) ?? {
          dimension: ref.dimension,
          hierarchy: ref.hierarchy,
          names: new Set<string>(),
        };
        entry.names.add(ref.element);
        byHierarchy.set(key, entry);
      });
    }

    const consolidated: string[] = [];
    for (const { dimension, hierarchy, names } of byHierarchy.values()) {
      try {
        const hits = await tm1Client.elements.consolidatedAmong(
          dimension,
          hierarchy,
          [...names],
        );
        for (const hit of hits) consolidated.push(`${dimension}:${hit}`);
      } catch (e) {
        // Fail closed. A probe that did not answer is not evidence that the
        // coordinates are leaves, and the tool promises every coordinate is
        // checked before anything is sent — so an unanswered probe stops the
        // write instead of reading as "no consolidations found".
        throw new TM1Error({
          code: e instanceof TM1Error ? e.code : "TM1_ERROR",
          message: `Could not check the elements of ${dimension}:${hierarchy} for consolidations: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`,
          hint: "Verify the dimension and hierarchy names — in `dimensions` and in any qualified element reference — then retry. Use tm1_check_writable_coords to inspect the coordinates first.",
          ...(e instanceof TM1Error && e.httpStatus !== undefined
            ? { httpStatus: e.httpStatus }
            : {}),
        });
      }
    }

    if (consolidated.length > 0) {
      throw new TM1Error({
        code: "VALIDATION_ERROR",
        message: `Consolidated coordinates in this write: ${consolidated.join(", ")}. Nothing was sent.`,
        hint: "Write to N-level (leaf) elements instead — tm1_check_writable_coords reports the level of every coordinate. There is no override: an aggregate is computed from the leaves below it, so load those, or run a TI process via tm1_execute_process.",
      });
    }
    // writeCells throws a TM1Error carrying its own partial-commit accounting
    // (written / failed / notAttempted) + a targeted hint, so we let it
    // propagate to the index.ts Proxy unwrapped — wrapping it here would
    // clobber that hint with a generic one.
    await tm1Client.cells.writeCells(cubeName, dimensions, cells);
    return actionResponse({ success: true, cellsWritten: cells.length });
  },
});
