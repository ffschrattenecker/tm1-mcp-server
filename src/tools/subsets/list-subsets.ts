import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, columnsOf } from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { SubsetSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

export const registerListSubsets = defineTool({
  name: "tm1_list_subsets",
  description:
    "List public + private subsets of a TM1 hierarchy. Returns names, scope (public/private), MDX expression preview, and alias. Paginated (default 50/page).",
  annotations: READ_ONLY,
  output: pageShapeFor(SubsetSchema),
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z
      .string()
      .describe("Hierarchy name (commonly equal to the dimension name)"),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { dimensionName, hierarchyName, limit, offset, fetchAll, format },
    tm1Client,
  ) => {
    const subsets = await tm1Client.subsets.list(dimensionName, hierarchyName);
    const page = paginate(subsets, limit, offset, fetchAll);
    type Row = (typeof subsets)[number];
    const columns = columnsOf<Row>([
      "name",
      { header: "scope", get: (s) => (s.private ? "private" : "public") },
      "alias",
      "expression",
    ]);
    return pageResponse(page, format, {
      title: `Subsets of ${dimensionName}/${hierarchyName}`,
      columns,
    });
  },
});
