import { z } from "zod";
import { PAGINATION_SCHEMA, UNBOUNDED_MAX_ITEMS } from "../pagination.js";
import { FORMAT_SCHEMA, payloadResponse } from "../format.js";
import { renderMdxMarkdown, type MdxEnvelope } from "./execute-mdx.js";
import { clipAxesToWindow } from "../../tm1-client/services/cellset-transform.js";
import { READ_ONLY } from "../annotations.js";
import { ViewResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

interface ViewEnvelope extends MdxEnvelope {
  cubeName: string;
  viewName: string;
}

export const registerGetView = defineTool({
  name: "tm1_get_view",
  description: [
    "Execute a named cube view and return structured cell data with axes (page-envelope shape consistent with tm1_execute_mdx).",
    "Cells paginate by default so wide/tall views don't flood context; fetchAll=true returns up to 5000 cells in one call; has_more/next_offset tell where to resume.",
    "format='markdown' renders a pivot grid (2 axes, full result) or a flat coordinate table; 'json' (default) returns the structured envelope.",
  ],
  annotations: READ_ONLY,
  output: ViewResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    viewName: z.string().describe("Name of the view to execute"),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { cubeName, viewName, limit, offset, fetchAll, format },
    tm1Client,
    extra,
  ) => {
    const all = fetchAll === true || limit === 0;
    // "All" is the documented first slab of UNBOUNDED_MAX_ITEMS, pushed down
    // to TM1 as $top — not the whole cellset. has_more/next_offset then say
    // where to resume, exactly as for any other page.
    const top = all ? UNBOUNDED_MAX_ITEMS : limit;
    const skip = all ? 0 : offset;
    const result = await tm1Client.views.getView(
      cubeName,
      viewName,
      top,
      skip,
      {
        signal: extra?.signal,
      },
    );

    const total = result.totalCellCount;
    const count = result.cells.length;
    const off = all ? 0 : offset;
    const has_more = off + count < total;
    // Clip axes to the returned cell page so a capped read over a tall view
    // doesn't ship the full tuple list.
    const { axes, clipped } = clipAxesToWindow(result.axes, count, off);
    const envelope: ViewEnvelope = {
      cubeName,
      viewName,
      axes,
      total,
      count,
      offset: off,
      has_more,
      next_offset: has_more ? off + count : null,
      ...(clipped ? { axes_clipped: true } : {}),
      items: result.cells,
    };
    return payloadResponse(envelope, format, renderMdxMarkdown);
  },
});
