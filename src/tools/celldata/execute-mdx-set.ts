import { z } from "zod";
import type { MdxSetTuple } from "../../types.js";
import { PAGINATION_SCHEMA, UNBOUNDED_MAX_ITEMS } from "../pagination.js";
import {
  FORMAT_SCHEMA,
  columnsOf,
  pageResponse,
  type Column,
} from "../format.js";
import { withToolHint } from "../error-format.js";
import { MdxSetResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { extraSignal } from "../context.js";

export const registerExecuteMdxSet = defineTool({
  name: "tm1_execute_mdx_set",
  description: [
    "Evaluate an MDX set expression against TM1 (ExecuteMDXSetExpression) and return paginated tuples with member metadata.",
    "Use to test subset/view axis expressions, TM1FILTERBYLEVEL, FILTER, DRILLDOWNMEMBER, or crossjoins without querying a cube.",
  ],
  annotations: READ_ONLY,
  output: MdxSetResultSchema,
  input: {
    mdx: z
      .string()
      .min(1)
      .describe(
        "MDX set expression to evaluate, e.g. {TM1FILTERBYLEVEL({TM1SUBSETALL([Time].[Time])}, 0)}.",
      ),
    includeElementInfo: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include element Type and Level per member (default true)."),
    includeAttributes: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include member Attributes map (default false)."),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe("Override default 30s request timeout (ms, 1000–3600000)."),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    {
      mdx,
      includeElementInfo,
      includeAttributes,
      timeoutMs,
      limit,
      offset,
      format,
    },
    tm1Client,
    extra,
  ) => {
    const all = limit === 0;
    const top = all ? UNBOUNDED_MAX_ITEMS : limit;
    const skip = all ? 0 : offset;

    const result = await withToolHint(
      tm1Client.cells.executeMdxSet(mdx, {
        top,
        skip,
        includeElementInfo,
        includeAttributes,
        request: {
          signal: extraSignal(extra),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      }),
      "MDX set expression failed. Verify dimension/hierarchy/member brackets ([Dim].[Hier].[Member]) and set braces ({...}).",
    );

    const total = result.cardinality;
    const count = result.tuples.length;
    const has_more = skip + count < total;
    const page = {
      total,
      count,
      offset: skip,
      has_more,
      next_offset: has_more ? skip + count : null,
      items: result.tuples,
    };

    const columns: Column<MdxSetTuple>[] = columnsOf<MdxSetTuple>([
      "ordinal",
      {
        header: "members",
        get: (t) => t.members.map((m) => m.name).join(" / "),
      },
      {
        header: "uniqueNames",
        get: (t) => t.members.map((m) => m.uniqueName ?? m.name).join(" / "),
      },
      {
        header: "type",
        get: (t) => t.members.map((m) => m.type ?? "").join(" / "),
      },
      {
        header: "level",
        get: (t) =>
          t.members
            .map((m) => (m.level !== undefined ? String(m.level) : ""))
            .join(" / "),
      },
      ...(includeAttributes
        ? [
            {
              header: "attributes",
              get: (t: MdxSetTuple) => t.members.map((m) => m.attributes ?? {}),
            },
          ]
        : []),
    ]);

    return pageResponse(page, format, {
      title: "MDX set expression",
      columns,
    });
  },
});
