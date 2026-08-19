import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
export const registerMoveElement = defineTool({
  name: "tm1_move_element",
  description:
    "Move an element to a new parent within a TM1 dimension hierarchy",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the dimension"),
    hierarchyName: z.string().describe("Name of the hierarchy"),
    elementName: z.string().describe("Name of the element to move"),
    newParent: z.string().describe("Name of the new parent element"),
    weight: z
      .number()
      .optional()
      .describe("Weight for the parent-child relationship (default: 1)"),
  },
  handler: async (
    { dimensionName, hierarchyName, elementName, newParent, weight },
    tm1Client,
  ) => {
    await tm1Client.elements.move(
      dimensionName,
      hierarchyName,
      elementName,
      newParent,
      weight,
    );
    return actionResponse({ success: true, elementName, newParent });
  },
});
