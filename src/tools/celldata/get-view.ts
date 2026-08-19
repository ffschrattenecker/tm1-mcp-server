import { z } from "zod";
import { PAGINATION_SCHEMA } from "../pagination.js";
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
    "Cells paginate by default so wide/tall views don't flood context; fetchAll=true for the full cellset.",
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
    const top = all ? undefined : limit;
    const skip = all ? undefined : offset;
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
    const has_more = !all && off + count < total;
    // Clip axes to the returned cell page so a capped read over a tall view
    // doesn't ship the full tuple list. fetchAll keeps the whole cellset.
    const { axes, clipped } = all
      ? { axes: result.axes, clipped: false }
      : clipAxesToWindow(result.axes, count, off);
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
