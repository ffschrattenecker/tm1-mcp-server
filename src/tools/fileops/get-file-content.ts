import { z } from "zod";
import { FileContentResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { CONTAINER_SCHEMA } from "./container.js";

// Below the server's 80k-character response limit (TM1_MAX_RESPONSE_CHARS)
// once JSON escaping is added; the old 256 KB default could never be returned.
const DEFAULT_MAX_BYTES = 64 * 1024;
// base64 grows the body by 4/3: 48 KB comes out at 64k characters, where the
// text default would come out at ~87k and be refused by the size guard.
const DEFAULT_BASE64_MAX_BYTES = 48 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;

export const registerGetFileContent = defineTool({
  name: "tm1_get_file_content",
  description: [
    "Read the content of a file from the TM1 server's data directory.",
    "Use to inspect CSV, TXT, or other text files before building import processes.",
    "Auto-falls back from v12 (Files) to v11 (Blobs) container. Set container='applications' to read a document out of the Applications tree; a folder or a view reference there carries no content and is refused by name.",
    "encoding='base64' returns the bytes untouched — use it for spreadsheets and other binaries, which a text read would corrupt.",
    "Response is truncated to maxBytes (default 64 KB, 48 KB for base64) to keep MCP messages small.",
  ],
  annotations: READ_ONLY,
  output: FileContentResultSchema,
  input: {
    fileName: z
      .string()
      .describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv')",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_BYTES)
      .optional()
      .describe(
        `Truncate response after N bytes (default ${DEFAULT_MAX_BYTES}, ${DEFAULT_BASE64_MAX_BYTES} for base64; hard max ${HARD_MAX_BYTES}).`,
      ),
    ...CONTAINER_SCHEMA,
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe(
        "How to return the body. 'text' (default) decodes as UTF-8; 'base64' hands back the raw bytes. headLines only applies to text.",
      ),
    headLines: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe(
        "If set, only return the first N lines (overrides byte truncation).",
      ),
  },
  handler: async (
    { fileName, maxBytes: requestedMaxBytes, headLines, container, encoding },
    tm1Client,
  ) => {
    const maxBytes =
      requestedMaxBytes ??
      (encoding === "base64" ? DEFAULT_BASE64_MAX_BYTES : DEFAULT_MAX_BYTES);
    const bytes = await tm1Client.files.getContentBytes(fileName, container);
    const totalBytes = bytes.byteLength;

    let body: string;
    let truncated = false;
    let truncationReason: string | undefined;

    if (encoding === "base64") {
      const slice = bytes.subarray(0, maxBytes);
      body = slice.toString("base64");
      if (slice.byteLength < totalBytes) {
        truncated = true;
        truncationReason = `maxBytes=${maxBytes}`;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              fileName,
              totalBytes,
              returnedBytes: slice.byteLength,
              truncated,
              ...(truncationReason ? { truncationReason } : {}),
              encoding,
              content: body,
            }),
          },
        ],
      };
    }

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

    const payload = {
      fileName,
      totalBytes,
      returnedBytes: Buffer.byteLength(body, "utf8"),
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
