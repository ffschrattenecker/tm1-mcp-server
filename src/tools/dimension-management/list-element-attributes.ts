import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, columnsOf } from "../format.js";
import { ElementAttributeDefinitionSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

export const registerListElementAttributes = defineTool({
  name: "tm1_list_element_attributes",
  description:
    "List element attribute definitions of a TM1 hierarchy with their types (Numeric/String/Alias). Useful to verify attribute schema before writing values or referencing them in rules (ATTRN/ATTRS).",
  annotations: READ_ONLY,
  output: pageShapeFor(ElementAttributeDefinitionSchema),
  input: {
    dimensionName: z.string().describe("Name of the TM1 dimension"),
    hierarchyName: z
      .string()
      .describe("Name of the hierarchy within the dimension"),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { dimensionName, hierarchyName, limit, offset, fetchAll, format },
    tm1Client,
  ) => {
    const attributes = await tm1Client.elements.listAttributes(
      dimensionName,
      hierarchyName,
    );
    const page = paginate(attributes, limit, offset, fetchAll);
    type Row = (typeof attributes)[number];
    const columns = columnsOf<Row>(["name", "type"]);
    return pageResponse(page, format, {
      title: `Element attributes of ${dimensionName}/${hierarchyName}`,
      columns,
    });
  },
});
