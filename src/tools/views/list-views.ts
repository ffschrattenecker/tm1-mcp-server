import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, columnsOf } from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { ViewItemSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

export const registerListViews = defineTool({
  name: "tm1_list_views",
  description:
    "List public and private views defined on a cube. Returns view name, visibility, and MDX (when available). Paginated (default 50/page).",
  annotations: READ_ONLY,
  output: pageShapeFor(ViewItemSchema),
  input: {
    cubeName: z.string().describe("Cube name"),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async ({ cubeName, limit, offset, fetchAll, format }, tm1Client) => {
    const views = await tm1Client.views.list(cubeName);
    const page = paginate(views, limit, offset, fetchAll);
    type Row = (typeof views)[number];
    const columns = columnsOf<Row>([
      "name",
      { header: "scope", get: (v) => (v.private ? "private" : "public") },
      "mdx",
    ]);
    return pageResponse(page, format, {
      title: `Views of ${cubeName}`,
      columns,
    });
  },
});
