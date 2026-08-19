import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCreateCube = defineTool({
  name: "tm1_create_cube",
  description: [
    "Create a new TM1 cube with the specified dimensions.",
    "The dimension order matters for performance: put dimensions used most often in WHERE clauses first.",
    "All referenced dimensions must exist before calling this tool.",
    "Fails if a cube with the same name already exists — no idempotent variant; delete first with tm1_delete_cube if you intend to replace.",
    "After: tm1_set_cube_rules for calculations, tm1_create_mdx_view for default slices.",
  ],
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube name"),
    dimensions: z
      .array(z.string())
      .min(2)
      .describe(
        "Ordered list of dimension names. Order affects query performance.",
      ),
  },
  handler: async ({ cubeName, dimensions }, tm1Client) => {
    await tm1Client.cubes.create(cubeName, dimensions);
    return actionResponse({
      success: true,
      cubeName,
      dimensionCount: dimensions.length,
      dimensions,
    });
  },
});
