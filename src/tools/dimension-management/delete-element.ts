import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerDeleteElement = defineTool({
  name: "tm1_delete_element",
  description:
    "Delete an element from a TM1 dimension hierarchy. Irreversible — pass confirm=<element name verbatim>. Data loss: a leaf that exists in no other hierarchy of the dimension takes its cell values in every cube that uses the dimension, and its attribute values, with it.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the dimension"),
    hierarchyName: z.string().describe("Name of the hierarchy"),
    elementName: z.string().describe("Name of the element to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { dimensionName, hierarchyName, elementName, confirm },
    tm1Client,
  ) => {
    requireConfirm(confirm, elementName, "element");
    await tm1Client.elements.delete(dimensionName, hierarchyName, elementName);
    return actionResponse({ success: true, elementName });
  },
});
