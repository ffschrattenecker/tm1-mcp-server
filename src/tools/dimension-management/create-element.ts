import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
const elementSchema = z.object({
  name: z.string().describe("Element name"),
  type: z.enum(["Numeric", "String", "Consolidated"]).describe("Element type"),
  components: z
    .array(z.object({ name: z.string(), weight: z.number() }))
    .optional()
    .describe("Child components for consolidated elements"),
});

export const registerCreateElement = defineTool({
  name: "tm1_create_element",
  description: "Create a new element in a TM1 dimension hierarchy",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the dimension"),
    hierarchyName: z.string().describe("Name of the hierarchy"),
    element: elementSchema.describe(
      "Element definition with name, type and optional components",
    ),
  },
  handler: async ({ dimensionName, hierarchyName, element }, tm1Client) => {
    await tm1Client.elements.create(dimensionName, hierarchyName, element);
    return actionResponse({ success: true, elementName: element.name });
  },
});
