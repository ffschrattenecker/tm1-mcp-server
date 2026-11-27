import { z } from "zod";
import { PAGINATION_SCHEMA, UNBOUNDED_MAX_ITEMS } from "../pagination.js";
import { FORMAT_SCHEMA, payloadResponse } from "../format.js";
import { renderMdxMarkdown, type MdxEnvelope } from "./execute-mdx.js";
import { clipAxesToWindow } from "../../tm1-client/services/cellset-transform.js";
import { READ_ONLY } from "../annotations.js";
import { ViewResultSchema } from "../schemas/items.js";
import { CellMetadataPropertySchema } from "../../schemas/cells.js";
import { defineTool } from "../define-tool.js";
import { extraSignal } from "../context.js";
import { cleanSandboxName } from "../../lib/sandbox-policy.js";

interface ViewEnvelope extends MdxEnvelope {
  cubeName: string;
  viewName: string;
  private?: boolean;
}

export const registerGetView = defineTool({
  name: "tm1_get_view",
  description: [
    "Execute a named public or private cube view and return structured cell data with axes.",
    "Cells paginate by default; has_more/next_offset tell where to resume.",
  ],
  annotations: READ_ONLY,
  output: ViewResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    viewName: z.string().describe("Name of the view to execute"),
    private: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Execute a private view (PrivateViews) instead of a public view (Views).",
      ),
    sandbox: z
      .string()
      .optional()
      .describe("Evaluate the view in this sandbox instead of base data."),
    cellProperties: z
      .array(CellMetadataPropertySchema)
      .optional()
      .describe(
        "Optional cell metadata flags to return per cell: RuleDerived, Updateable, HasPicklist.",
      ),
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
      cubeName,
      viewName,
      private: isPrivate,
      sandbox,
      cellProperties,
      timeoutMs,
      limit,
      offset,
      format,
    },
    tm1Client,
    extra,
  ) => {
    const all = limit === 0;
    // "All" is the documented first slab of UNBOUNDED_MAX_ITEMS, pushed down
    // to TM1 as $top — not the whole cellset. has_more/next_offset then say
    // where to resume, exactly as for any other page.
    const top = all ? UNBOUNDED_MAX_ITEMS : limit;
    const skip = all ? 0 : offset;
    const cleanedSandbox = cleanSandboxName(sandbox);
    const hasViewOpts =
      isPrivate || cleanedSandbox !== undefined || cellProperties !== undefined;
    const result = await tm1Client.views.getView(
      cubeName,
      viewName,
      top,
      skip,
      {
        signal: extraSignal(extra),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
      hasViewOpts
        ? {
            ...(isPrivate ? { isPrivate: true } : {}),
            ...(cleanedSandbox !== undefined
              ? { sandbox: cleanedSandbox }
              : {}),
            ...(cellProperties !== undefined ? { cellProperties } : {}),
          }
        : undefined,
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
      ...(isPrivate ? { private: true } : {}),
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
