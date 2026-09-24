import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { HIERARCHY_NAME_OPTIONAL, resolveHierarchy } from "../hierarchy.js";
export const registerCreateElementAttribute = defineTool({
  name: "tm1_create_element_attribute",
  description:
    "Create an element attribute definition (schema) on a TM1 hierarchy. For reproducible deployments prefer a TI process (DimensionElementInsert on the }ElementAttributes_{dim} control cube). Use this tool for ad-hoc / debugging scenarios or when explicitly requested.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the TM1 dimension"),
    ...HIERARCHY_NAME_OPTIONAL,
    attributeName: z.string().describe("Name of the new attribute"),
    attributeType: z
      .enum(["Numeric", "String", "Alias"])
      .describe("Attribute type: Numeric (ATTRN), String (ATTRS), or Alias"),
  },
  handler: async (
    { dimensionName, hierarchyName, attributeName, attributeType },
    tm1Client,
  ) => {
    const hierarchy = resolveHierarchy(dimensionName, hierarchyName);
    await tm1Client.elements.createAttribute(
      dimensionName,
      hierarchy,
      attributeName,
      attributeType,
    );
    return actionResponse({ success: true, attributeName, attributeType });
  },
});
