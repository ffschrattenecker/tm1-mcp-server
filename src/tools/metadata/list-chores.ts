import { z } from "zod";
import type { Chore } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, columnsOf } from "../format.js";
import { ChoreItemSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

type ChoreCompact = {
  name: string;
  active: boolean;
  startTime: string;
  frequency: string;
  processCount: number;
};

export const registerListChores = defineTool({
  name: "tm1_list_chores",
  description: [
    "List chores in the TM1 server with schedule and assigned processes. compact=true replaces processes[] with processCount; processNameContains filters by referenced process.",
    "Paginated (default 50/page).",
  ],
  annotations: READ_ONLY,
  output: pageShapeFor(ChoreItemSchema),
  input: {
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
    compact: z
      .boolean()
      .optional()
      .default(false)
      .describe("Replace processes[] with processCount (default: false)."),
    processNameContains: z
      .string()
      .optional()
      .describe(
        "Return only chores whose steps reference a process name containing this substring (case-insensitive).",
      ),
  },
  handler: async (
    { limit, offset, fetchAll, format, compact, processNameContains },
    tm1Client,
  ) => {
    const chores = await tm1Client.chores.list();
    const filtered = (() => {
      if (processNameContains === undefined || processNameContains.length === 0)
        return chores;
      const needle = processNameContains.toLowerCase();
      return chores.filter((c) =>
        c.processes.some((p) => p.name.toLowerCase().includes(needle)),
      );
    })();
    const projected: Array<Chore | ChoreCompact> = compact
      ? filtered.map((c): ChoreCompact => ({
          name: c.name,
          active: c.active,
          startTime: c.startTime,
          frequency: c.frequency,
          processCount: c.processes.length,
        }))
      : filtered;
    const page = paginate(projected, limit, offset, fetchAll);
    type Row = (typeof projected)[number];
    const columns = columnsOf<Row>([
      "name",
      "active",
      "startTime",
      "frequency",
      {
        header: "processes",
        get: (c) =>
          "processes" in c
            ? c.processes.map((p) => p.name).join(", ")
            : `${c.processCount} (compact)`,
      },
    ]);
    return pageResponse(page, format, { title: "Chores", columns });
  },
});
