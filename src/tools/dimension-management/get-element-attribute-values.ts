import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import { ElementAttributeValueSchema } from "../schemas/items.js";
import { CellValueSchema } from "../../schemas/common.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import {
  PAGINATION_SCHEMA,
  UNBOUNDED_MAX_ITEMS,
  pageFromServer,
} from "../pagination.js";
import { pageShapeFor } from "../schemas/common.js";

const ElementValuesRowSchema = z.object({
  elementName: z.string(),
  values: z.record(z.string(), CellValueSchema),
});

// Two shapes behind one tool: a single element's attribute rows, or a page of
// elements with an attribute → value map each. Every field of both is
// optional here so either payload validates.
const pageShape = pageShapeFor(ElementValuesRowSchema);

export const registerGetElementAttributeValues = defineTool({
  name: "tm1_get_element_attribute_values",
  description: [
    "Read attribute values (Numeric/String/Alias) via MDX on the }ElementAttributes_{Dim} control cube. Use this to verify alias values, attribute lookups, or to debug rules referencing ATTRN/ATTRS.",
    "With elementName: that element's attributes. Without: every element of the dimension, name-sorted and paged (items[{elementName, values}]); narrow the columns with attributeNames.",
  ],
  annotations: READ_ONLY,
  output: {
    dimensionName: z.string(),
    elementName: z.string().optional(),
    attributes: z.array(ElementAttributeValueSchema).optional(),
    total: pageShape.total.optional(),
    count: pageShape.count.optional(),
    offset: pageShape.offset.optional(),
    has_more: pageShape.has_more.optional(),
    next_offset: pageShape.next_offset.optional(),
    items: pageShape.items.optional(),
  },
  input: {
    dimensionName: z.string().describe("Dimension name"),
    elementName: z
      .string()
      .optional()
      .describe(
        "Element whose attribute values should be read. Omit to page through all elements.",
      ),
    attributeNames: z
      .array(z.string())
      .optional()
      .describe("Only these attributes (all-elements mode). Default: all."),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    {
      dimensionName,
      elementName,
      attributeNames,
      limit,
      offset,
      fetchAll,
      format,
    },
    tm1Client,
  ) => {
    if (elementName === undefined) {
      const unbounded = fetchAll || limit === 0;
      const start = unbounded ? 0 : offset;
      const { total, items } = await tm1Client.elements.getAttributeValuesPage(
        dimensionName,
        {
          offset: start,
          limit: unbounded ? UNBOUNDED_MAX_ITEMS : limit,
          ...(attributeNames !== undefined ? { attributeNames } : {}),
        },
      );
      const payload = {
        dimensionName,
        ...pageFromServer(items, total, start),
      };
      const attrs = Object.keys(items[0]?.values ?? {});
      type Row = (typeof items)[number];
      const columns = columnsOf<Row>([
        "elementName",
        ...attrs.map((a) => ({ header: a, get: (r: Row) => r.values[a] })),
      ]);
      return payloadResponse(
        payload,
        format,
        (p) =>
          `## Attributes of ${p.dimensionName} (${p.offset + 1}–${p.offset + p.count} of ${p.total})\n\n${renderTable(p.items, columns)}`,
      );
    }

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
