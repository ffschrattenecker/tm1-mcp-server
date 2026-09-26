import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerUpdateElementAttributeValue = defineTool({
  name: "tm1_update_element_attribute_value",
  description:
    "Set a single attribute value on an element by writing to the }ElementAttributes_{Dim} control cube. Pass hierarchyName for an element of an alternate hierarchy. A leaf's value is shared by every hierarchy of the dimension; a consolidation's value is set for that hierarchy only. For reproducible deployments prefer a TI process (CellPutS / CellPutN / AttrPutS / AttrPutN). Use this REST-direct tool for ad-hoc / debugging scenarios.",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    elementName: z
      .string()
      .describe("Element whose attribute value should be set"),
    hierarchyName: z
      .string()
      .optional()
      .describe(
        "Hierarchy the element belongs to (default: the same-named default hierarchy). Needed for elements of an alternate hierarchy.",
      ),
    attributeName: z
      .string()
      .describe("Attribute name (must already exist as schema)"),
    value: z
      .union([z.string(), z.number()])
      .describe(
        "New value (string for String/Alias attributes, number for Numeric attributes)",
      ),
  },
  handler: async (
    { dimensionName, elementName, hierarchyName, attributeName, value },
    tm1Client,
  ) => {
    await tm1Client.elements.updateAttributeValue(
      dimensionName,
      elementName,
      attributeName,
      value,
      hierarchyName,
    );
    return actionResponse({
      success: true,
      dimensionName,
      elementName,
      attributeName,
      value,
    });
  },
});
