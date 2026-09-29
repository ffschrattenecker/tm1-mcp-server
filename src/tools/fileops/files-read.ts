import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, wrappedPageResponse, columnsOf } from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { CONTAINER_SCHEMA } from "./container.js";
import { FilenameItemSchema } from "../schemas/items.js";
import { pageShapeFor } from "../schemas/common.js";

// Below the server's 80k-character response limit (TM1_MAX_RESPONSE_CHARS)
// once JSON escaping is added; the old 256 KB default could never be returned.
const DEFAULT_MAX_BYTES = 64 * 1024;
// base64 grows the body by 4/3: 48 KB comes out at 64k characters, where the
// text default would come out at ~87k and be refused by the size guard.
const DEFAULT_BASE64_MAX_BYTES = 48 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;

type Op = "list" | "search" | "get";

// One object for all three ops. A z.union output cannot be published (the
// SDK's zod-compat drops the outputSchema entirely, see
// ../schemas/markdown-capable.ts), so every key is optional and each op fills
// its own subset: list/search the page envelope plus echoed filters, get the
// file-content fields. The key sets do not overlap.
const page = pageShapeFor(FilenameItemSchema);
export const FilesReadResultSchema = z.object({
  path: z.string().optional().describe("list/search: folder (echoes input)"),
  startswith: z.string().nullable().optional(),
  contains: z.array(z.string()).nullable().optional(),
  operator: z.enum(["and", "or"]).optional(),
  total: page.total.optional(),
  count: page.count.optional(),
  offset: page.offset.optional(),
  has_more: page.has_more.optional(),
  next_offset: page.next_offset.optional(),
  items: page.items.optional(),
  fileName: z.string().optional(),
  totalBytes: z.number().int().optional(),
  returnedBytes: z.number().int().optional(),
  truncated: z.boolean().optional(),
  truncationReason: z.string().optional(),
  encoding: z.enum(["text", "base64"]).optional(),
  content: z.string().optional(),
});

// Fields that belong to one op only and carry no schema default, so their
// presence on another op is a real mistake by the caller, not a parse artifact.
const OWNED_BY: Record<string, readonly Op[]> = {
  path: ["list", "search"],
  startswith: ["search"],
  contains: ["search"],
  fileName: ["get"],
  maxBytes: ["get"],
  headLines: ["get"],
};

function validationError(message: string, hint: string): TM1Error {
  return new TM1Error({ code: TM1ErrorCode.VALIDATION_ERROR, message, hint });
}

export const registerFilesRead = defineTool({
  name: "tm1_files_read",
  description: [
    "Read the TM1 server's file storage (TI data directory: Files on v12, Blobs on v11; auto-fallback).",
    "op='list': names in a folder (path). op='search': case-insensitive name match by startswith and/or contains (joined by operator). Both paginated (default 50/page).",
    "op='get': file content (fileName), truncated to maxBytes (default 64 KB, 48 KB for base64). encoding='base64' returns the bytes untouched — use it for spreadsheets and other binaries, which a text read would corrupt.",
    "container='applications' addresses the Applications tree instead; there a folder or a view reference carries no content and get refuses it by name.",
  ],
  annotations: READ_ONLY,
  output: FilesReadResultSchema,
  input: {
    op: z.enum(["list", "search", "get"]),
    path: z
      .string()
      .optional()
      .describe(
        "list/search: subfolder (e.g. 'imports/2024'); empty = root. search: v12 only.",
      ),
    startswith: z
      .string()
      .optional()
      .describe("search: case-insensitive name prefix (e.g. 'sales_')."),
    contains: z
      .array(z.string())
      .optional()
      .describe(
        "search: case-insensitive substrings the name must contain (joined by operator).",
      ),
    operator: z
      .enum(["and", "or"])
      .optional()
      .default("and")
      .describe("search: how to join contains."),
    fileName: z
      .string()
      .optional()
      .describe("get (required): file name or path (e.g. 'imports/a.csv')."),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_BYTES)
      .optional()
      .describe(
        `get: truncate after N bytes (default ${DEFAULT_MAX_BYTES}, ${DEFAULT_BASE64_MAX_BYTES} for base64).`,
      ),
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe(
        "get: 'text' decodes UTF-8; 'base64' returns raw bytes. headLines only applies to text.",
      ),
    headLines: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe("get: only the first N lines (overrides maxBytes)."),
    ...CONTAINER_SCHEMA,
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (args, tm1Client) => {
    const { op, container } = args;
    for (const [field, ops] of Object.entries(OWNED_BY)) {
      if (args[field as keyof typeof args] !== undefined && !ops.includes(op)) {
        throw validationError(
          `${field} does not apply to op="${op}" (only ${ops.map((o) => `op="${o}"`).join(" / ")}). Nothing was read.`,
          "Drop the field or switch op: list takes path; search takes startswith/contains/operator/path; get takes fileName/maxBytes/encoding/headLines.",
        );
      }
    }

    if (op === "list") {
      const { path, limit, offset, fetchAll, format } = args;
      const files = await tm1Client.files.list(path, container);
      const pageData = paginate(files, limit, offset, fetchAll);
      const wrapper = { path: path ?? "", ...pageData };
      type Row = (typeof files)[number];
      const columns = columnsOf<Row>([{ header: "filename", get: (f) => f }]);
      return wrappedPageResponse(wrapper, pageData, format, {
        title: `Files in /${path ?? ""}`,
        columns,
      });
    }

    if (op === "search") {
      const {
        startswith,
        contains,
        operator,
        path,
        limit,
        offset,
        fetchAll,
        format,
      } = args;
      const names = await tm1Client.files.search({
        startswith,
        contains,
        operator,
        path,
        container,
      });
      const pageData = paginate(names, limit, offset, fetchAll);
      // Echo the filters so callers can correlate matches with the request.
      const wrapper = {
        path: path ?? "",
        startswith: startswith ?? null,
        contains: contains ?? null,
        operator,
        ...pageData,
      };
      type Row = (typeof names)[number];
      const columns = columnsOf<Row>([{ header: "filename", get: (f) => f }]);
      return wrappedPageResponse(wrapper, pageData, format, {
        title: `File search results in /${path ?? ""}`,
        columns,
      });
    }

    // op === "get"
    const {
      fileName,
      maxBytes: requestedMaxBytes,
      headLines,
      encoding,
      format,
    } = args;
    if (fileName === undefined || fileName === "") {
      throw validationError(
        'op="get" needs fileName. Nothing was read.',
        'Pass fileName (e.g. "imports/a.csv"); find it first with op="list" or op="search".',
      );
    }
    // get answers with the content payload only; a markdown table of one file
    // body would be a different response shape than the one declared.
    if (format === "markdown") {
      throw validationError(
        'format="markdown" applies to op="list" / op="search" only. Nothing was read.',
        'Drop format for op="get".',
      );
    }
    const maxBytes =
      requestedMaxBytes ??
      (encoding === "base64" ? DEFAULT_BASE64_MAX_BYTES : DEFAULT_MAX_BYTES);
    const bytes = await tm1Client.files.getContentBytes(fileName, container);
    const totalBytes = bytes.byteLength;

    let body: string;
    let returnedBytes: number;
    let truncated = false;
    let truncationReason: string | undefined;

    if (encoding === "base64") {
      const slice = bytes.subarray(0, maxBytes);
      body = slice.toString("base64");
      // Count the bytes, not the base64 characters.
      returnedBytes = slice.byteLength;
      if (slice.byteLength < totalBytes) {
        truncated = true;
        truncationReason = `maxBytes=${maxBytes}`;
      }
    } else {
      const content = bytes.toString("utf8");
      if (headLines !== undefined) {
        const allLines = content.split("\n");
        body = allLines.slice(0, headLines).join("\n");
        if (allLines.length > headLines) {
          truncated = true;
          truncationReason = `headLines=${headLines} (of ${allLines.length})`;
        }
      } else if (totalBytes > maxBytes) {
        body = Buffer.from(content, "utf8")
          .subarray(0, maxBytes)
          .toString("utf8");
        truncated = true;
        truncationReason = `maxBytes=${maxBytes}`;
      } else {
        body = content;
      }
      returnedBytes = Buffer.byteLength(body, "utf8");
    }

    const payload = {
      fileName,
      totalBytes,
      returnedBytes,
      truncated,
      ...(truncationReason ? { truncationReason } : {}),
      encoding,
      content: body,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
