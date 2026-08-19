import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";
import { GroupItemSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

export const registerListGroups = defineTool({
  name: "tm1_list_groups",
  description:
    "List TM1 groups. Defaults return Name + Clients[] (member usernames). Use compact=true to replace Clients[] with an integer clientCount — large savings when groups have many members.",
  annotations: READ_ONLY,
  output: pageShapeFor(GroupItemSchema),
  input: {
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
    compact: z
      .boolean()
      .optional()
      .describe(
        "If true, replace Clients[] with clientCount: number on each group. Use for audits where membership names aren't needed.",
      ),
  },
  handler: async ({ limit, offset, fetchAll, format, compact }, tm1Client) => {
    const groups = await tm1Client.security.listGroups();
    const page = paginate(groups, limit, offset, fetchAll);
    const items = compact
      ? page.items.map(({ Clients, ...rest }) => ({
          ...rest,
          clientCount: Clients?.length ?? 0,
        }))
      : page.items;
    const projectedPage = { ...page, items };
    type Row = (typeof items)[number];
    const columns: Column<Row>[] = [
      { header: "Name", get: (g) => g.Name },
      {
        header: "Clients",
        get: (g) =>
          "clientCount" in g
            ? `${g.clientCount} (count)`
            : (g.Clients ?? []).join(", "),
      },
    ];
    return pageResponse(projectedPage, format, { title: "Groups", columns });
  },
});
