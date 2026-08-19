import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCreateDimension = defineTool({
  name: "tm1_create_dimension",
  description: [
    "Create a new TM1 dimension with a default hierarchy of the same name.",
    "Fails if the dimension already exists. After: tm1_create_element / tm1_bulk_upsert_elements to populate, tm1_create_hierarchy for alternate hierarchies.",
  ],
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
  },
  handler: async ({ dimensionName }, tm1Client) => {
    await tm1Client.dimensions.create(dimensionName);
    return actionResponse({ success: true, dimensionName });
  },
});
