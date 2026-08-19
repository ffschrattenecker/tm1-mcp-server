import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import { ElementAttributeValueSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetElementAttributeValues = defineTool({
  name: "tm1_get_element_attribute_values",
  description:
    "Read all attribute values (Numeric/String/Alias) for a single element via MDX on the }ElementAttributes_{Dim} control cube. Use this to verify alias values, attribute lookups, or to debug rules referencing ATTRN/ATTRS.",
  annotations: READ_ONLY,
  output: {
    dimensionName: z.string(),
    elementName: z.string(),
    attributes: z.array(ElementAttributeValueSchema),
  },
  input: {
    dimensionName: z.string().describe("Dimension name"),
    elementName: z
      .string()
      .describe("Element whose attribute values should be read"),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ dimensionName, elementName, format }, tm1Client) => {
    const values = await tm1Client.elements.getAttributeValues(
      dimensionName,
      elementName,
    );
    const payload = { dimensionName, elementName, attributes: values };
    type Row = (typeof values)[number];
    const columns = columnsOf<Row>([
      { header: "attribute", get: (a) => a.attributeName },
      "value",
    ]);
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Attributes of ${p.dimensionName}/${p.elementName}\n\n${renderTable(p.attributes, columns)}`,
    );
  },
});
