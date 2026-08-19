import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, wrappedPageResponse, type Column } from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { FilenameItemSchema } from "../schemas/items.js";
import { pageShapeFor } from "../schemas/common.js";

// tm1_list_files prefixes a `path` field on top of the page envelope.
const filePageShape = {
  path: z.string().describe("Path that was listed (echoes the input)"),
  ...pageShapeFor(FilenameItemSchema),
};

export const registerListFiles = defineTool({
  name: "tm1_list_files",
  description: [
    "List files in the TM1 server's data directory (blob/file storage).",
    "Use to browse available CSV, TXT, or other files before building import processes.",
    "Supports subfolder navigation via the path parameter.",
    "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
    "Paginated (default 50/page).",
  ],
  annotations: READ_ONLY,
  output: filePageShape,
  input: {
    path: z
      .string()
      .optional()
      .describe(
        "Subfolder path (e.g. 'imports' or 'imports/2024'). Empty = root.",
      ),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async ({ path, limit, offset, fetchAll, format }, tm1Client) => {
    const files = await tm1Client.files.list(path);
    const page = paginate(files, limit, offset, fetchAll);
    const wrapper = { path: path ?? "", ...page };
    type Row = (typeof files)[number];
    const columns: Column<Row>[] = [{ header: "filename", get: (f) => f }];
    return wrappedPageResponse(wrapper, page, format, {
      title: `Files in /${path ?? ""}`,
      columns,
    });
  },
});
