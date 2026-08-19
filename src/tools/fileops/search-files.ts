import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, wrappedPageResponse, type Column } from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { FilenameItemSchema } from "../schemas/items.js";
import { pageShapeFor } from "../schemas/common.js";

// tm1_search_files echoes the search filters alongside the page envelope so
// callers can correlate matches with the request that produced them.
const searchFilePageShape = {
  path: z.string().describe("Folder that was searched (echoes the input)"),
  startswith: z.string().nullable().describe("Prefix filter applied, or null"),
  contains: z
    .array(z.string())
    .nullable()
    .describe("Substring filters applied, or null"),
  operator: z
    .enum(["and", "or"])
    .describe("How `contains` substrings were joined"),
  ...pageShapeFor(FilenameItemSchema),
};

export const registerSearchFiles = defineTool({
  name: "tm1_search_files",
  description: [
    "Search file names in the TM1 server's blob/file storage by prefix and/or substring.",
    "Use to find files when you only know part of the name (case-insensitive).",
    "Combines startswith and contains filters via the `operator` (and/or).",
    "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
    "Paginated (default 50/page).",
  ],
  annotations: READ_ONLY,
  output: searchFilePageShape,
  input: {
    startswith: z
      .string()
      .optional()
      .describe(
        "Case-insensitive prefix match on the file name (e.g. 'sales_').",
      ),
    contains: z
      .array(z.string())
      .optional()
      .describe(
        "List of case-insensitive substrings the name must contain (joined by `operator`).",
      ),
    operator: z
      .enum(["and", "or"])
      .optional()
      .default("and")
      .describe("How to join multiple `contains` substrings. Default 'and'."),
    path: z
      .string()
      .optional()
      .describe("Subfolder to search in (v12 only). Empty = root."),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { startswith, contains, operator, path, limit, offset, fetchAll, format },
    tm1Client,
  ) => {
    const names = await tm1Client.files.search({
      startswith,
      contains,
      operator,
      path,
    });
    const page = paginate(names, limit, offset, fetchAll);
    const wrapper = {
      path: path ?? "",
      startswith: startswith ?? null,
      contains: contains ?? null,
      operator,
      ...page,
    };
    type Row = (typeof names)[number];
    const columns: Column<Row>[] = [{ header: "filename", get: (f) => f }];
    return wrappedPageResponse(wrapper, page, format, {
      title: `File search results in /${path ?? ""}`,
      columns,
    });
  },
});
