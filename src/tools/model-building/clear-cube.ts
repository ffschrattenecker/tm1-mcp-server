import { z } from "zod";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerClearCube = defineTool({
  name: "tm1_clear_cube",
  description: [
    "Clear a subset of cells from a cube. For each dimension, pass either specific element names or an empty array to select all elements (wildcard).",
    "The dimensions array must match the cube's dimension order. Consolidated elements expand to their leaves. Prefer TI for reproducible loads — this is for ad-hoc resets.",
    "Irreversible: cleared cells return zero/empty on next read. Safety: pass confirm=<cube name verbatim>. Mismatched confirm rejects the call.",
    "Before: tm1_sample_cells to confirm the slice you intend to wipe.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube to clear"),
    dimensions: z.array(z.string()).describe("Cube's dimensions in order"),
    tuples: z
      .array(z.array(z.string()))
      .describe(
        "Per-dimension element lists (same length as dimensions). Empty array = all elements on that dimension.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, dimensions, tuples, confirm }, tm1Client) => {
    requireConfirm(confirm, cubeName, "cube");
    if (dimensions.length !== tuples.length) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `dimensions (${dimensions.length}) and tuples (${tuples.length}) must have the same length.`,
          },
        ],
      };
    }
    await tm1Client.cubes.clear(cubeName, dimensions, tuples);
    const summary = dimensions
      // dimensions.length === tuples.length is guarded above
      .map(
        (d, i) =>
          `${d}=${tuples[i]!.length === 0 ? "*" : tuples[i]!.join("|")}`,
      )
      .join(", ");
    return actionResponse({ success: true, cubeName, summary });
  },
});
