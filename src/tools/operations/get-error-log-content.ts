import { z } from "zod";
import {
  fetchRelatedLogs,
  tailLines,
  truncateTail,
  tsFromFilename,
} from "./error-log-helpers.js";
import { ErrorLogContentResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { jsonResult } from "../format.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RELATED_WINDOW_SEC = 10;
const HARD_MAX_RELATED_WINDOW_SEC = 300;
const DEFAULT_RELATED_MAX_FILES = 5;
const HARD_MAX_RELATED_FILES = 20;
const DEFAULT_RELATED_MAX_BYTES = 16 * 1024;

export const registerGetErrorLogContent = defineTool({
  name: "tm1_get_error_log_content",
  description: [
    "Fetch the raw text of one TI error log file produced by a failed process run.",
    "Use tm1_list_error_logs first to discover available filenames; response is tail/byte-truncated to protect the MCP context.",
    "includeRelated also pulls sibling logs within a timestamp window — useful for tracing cascade failures in chained TI processes.",
  ],
  annotations: READ_ONLY,
  output: ErrorLogContentResultSchema,
  input: {
    filename: z
      .string()
      .describe(
        "Exact filename returned by tm1_list_error_logs, e.g. 'MyProc_20260504_123045.log'",
      ),
    tail: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe(
        "If set, return only the last N lines (overrides maxBytes byte truncation).",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_BYTES)
      .optional()
      .default(DEFAULT_MAX_BYTES)
      .describe(
        `Truncate to last N bytes if no tail is given (default ${DEFAULT_MAX_BYTES}, hard max ${HARD_MAX_BYTES}).`,
      ),
    includeRelated: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, also fetch sibling error logs whose embedded YYYYMMDDHHMMSS timestamp is within ±relatedWindowSec of the source log.",
      ),
    relatedWindowSec: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_RELATED_WINDOW_SEC)
      .optional()
      .default(DEFAULT_RELATED_WINDOW_SEC)
      .describe(
        `Time window in seconds for related-log discovery (default ${DEFAULT_RELATED_WINDOW_SEC}, max ${HARD_MAX_RELATED_WINDOW_SEC}).`,
      ),
    relatedMaxFiles: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_RELATED_FILES)
      .optional()
      .default(DEFAULT_RELATED_MAX_FILES)
      .describe(
        `Cap on number of related logs returned (default ${DEFAULT_RELATED_MAX_FILES}, max ${HARD_MAX_RELATED_FILES}).`,
      ),
    relatedMaxBytes: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_BYTES)
      .optional()
      .default(DEFAULT_RELATED_MAX_BYTES)
      .describe(
        `Per-related-log byte cap (tail-truncated, default ${DEFAULT_RELATED_MAX_BYTES}).`,
      ),
  },
  handler: async (
    {
      filename,
      tail,
      maxBytes,
      includeRelated,
      relatedWindowSec,
      relatedMaxFiles,
      relatedMaxBytes,
    },
    tm1Client,
  ) => {
    const content = await tm1Client.server.getErrorLogContent(filename);
    const totalBytes = Buffer.byteLength(content, "utf8");

    let body: string;
    let truncated: boolean;
    let truncationReason: string | undefined;

    if (tail !== undefined) {
      const lines = tailLines(content, tail);
      body = lines.body;
      truncated = lines.truncated;
      if (truncated) {
        truncationReason = `tail=${tail} (of ${lines.totalLines} lines)`;
      }
    } else {
      const bytes = truncateTail(content, maxBytes);
      body = bytes.body;
      truncated = bytes.truncated;
      if (truncated) {
        truncationReason = `maxBytes=${maxBytes} (tail-truncated)`;
      }
    }

    const payload: Record<string, unknown> = {
      filename,
      totalBytes,
      returnedBytes: Buffer.byteLength(body, "utf8"),
      truncated,
      ...(truncationReason ? { truncationReason } : {}),
      content: body,
    };

    if (includeRelated) {
      const sourceTs = tsFromFilename(filename);
      if (sourceTs === null) {
        payload.related = {
          note: "Source filename has no embedded YYYYMMDDHHMMSS timestamp — relation lookup skipped.",
          files: [],
        };
      } else {
        const allFiles = await tm1Client.server.listErrorLogFiles({
          top: 500,
        });
        const related = await fetchRelatedLogs(
          tm1Client.server,
          allFiles,
          { filename, ts: sourceTs },
          {
            windowSec: relatedWindowSec,
            maxFiles: relatedMaxFiles,
            maxBytes: relatedMaxBytes,
          },
        );

        payload.related = {
          windowSec: relatedWindowSec,
          found: related.found,
          maxFiles: relatedMaxFiles,
          files: related.files,
        };
      }
    }

    return jsonResult(payload);
  },
});
