import { z } from "zod";
import { CellValueSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
export const registerGetCellValue = defineTool({
  name: "tm1_get_cell_value",
  description: [
    "Get a single cell value from a TM1 cube by specifying element coordinates.",
    "Discover dimension order with tm1_list_cubes (cube.dimensions).",
    "Reading more than a few cells? One tm1_execute_mdx (slices/grids) or tm1_sample_cells (populated cells) call replaces a loop of get_cell_value calls.",
    "Related: tm1_write_cells for the inverse operation.",
  ],
  annotations: READ_ONLY,
  output: {
    value: CellValueSchema.describe("Cell value (string, number, or null)"),
  },
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    elements: z
      .array(z.string())
      .describe("Element names for each dimension of the cube"),
  },
  handler: async ({ cubeName, elements }, tm1Client) => {
    const value = await tm1Client.cells.getValue(cubeName, elements);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ value }) }],
    };
  },
});
