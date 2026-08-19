import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
const updateSchema = z.object({
  newName: z.string().optional().describe("New name for the element"),
  type: z
    .enum(["Numeric", "String", "Consolidated"])
    .optional()
    .describe("New element type"),
  components: z
    .array(z.object({ name: z.string(), weight: z.number() }))
    .optional()
    .describe("New child components for consolidated elements"),
});

export const registerUpdateElement = defineTool({
  name: "tm1_update_element",
  description:
    "Update an existing element in a TM1 dimension hierarchy (name, type, or components)",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the dimension"),
    hierarchyName: z.string().describe("Name of the hierarchy"),
    elementName: z.string().describe("Current name of the element to update"),
    update: updateSchema.describe("Fields to update on the element"),
  },
  handler: async (
    { dimensionName, hierarchyName, elementName, update },
    tm1Client,
  ) => {
    await tm1Client.elements.update(
      dimensionName,
      hierarchyName,
      elementName,
      update,
    );
    return actionResponse({ success: true, elementName });
  },
});
