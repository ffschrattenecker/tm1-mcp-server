import { z } from "zod";
import {
  fetchRelatedLogs,
  matchesProcessName,
  tailLines,
  tsFromFilename,
} from "./error-log-helpers.js";
import { DiagnoseProcessErrorResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

const DEFAULT_TAIL_LINES = 60;
const DEFAULT_MAX_LOGS = 3;
const DEFAULT_RELATED_WINDOW_SEC = 10;
const DEFAULT_RELATED_MAX_FILES = 5;
const DEFAULT_RELATED_MAX_BYTES = 16 * 1024;

export const registerDiagnoseProcessError = defineTool({
  name: "tm1_diagnose_process_error",
  description: [
    "One-call error diagnosis for a failed TI process: lists matching error logs, fetches their content,",
    "and optionally includes cascade-related sibling logs (same timestamp window) in a single response.",
    "Returns logs newest-first.",
  ],
  annotations: READ_ONLY,
  output: DiagnoseProcessErrorResultSchema,
  input: {
    processName: z
      .string()
      .describe(
        "Process name to diagnose. Matches both TM1 filename conventions: modern 'TM1ProcessError_<ts>_<id>_<processName>.log' and legacy '<processName>_<ts>.log'.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "Only consider logs whose filename timestamp is >= this ISO timestamp, e.g. '2026-05-04T00:00:00'.",
      ),
    maxLogs: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(DEFAULT_MAX_LOGS)
      .describe(
        `Max number of log files to fetch (newest first, default ${DEFAULT_MAX_LOGS}).`,
      ),
    tail: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .default(DEFAULT_TAIL_LINES)
      .describe(
        `Lines to return from the end of each log (default ${DEFAULT_TAIL_LINES}).`,
      ),
    includeRelated: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Also fetch sibling logs within ±relatedWindowSec of each log's timestamp (cascade failure tracing). Default: true.",
      ),
    relatedWindowSec: z
      .number()
      .int()
      .min(1)
      .max(300)
      .optional()
      .default(DEFAULT_RELATED_WINDOW_SEC)
      .describe(
        `Time window in seconds for cascade log discovery (default ${DEFAULT_RELATED_WINDOW_SEC}).`,
      ),
    relatedMaxFiles: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(DEFAULT_RELATED_MAX_FILES)
      .describe(
        `Max related logs per primary log (default ${DEFAULT_RELATED_MAX_FILES}).`,
      ),
  },
  handler: async (
    {
      processName,
      since,
      maxLogs,
      tail,
      includeRelated,
      relatedWindowSec,
      relatedMaxFiles,
    },
    tm1Client,
  ) => {
    const allFiles = await tm1Client.server.listErrorLogFiles({
      since,
      top: 500,
    });
    const matching = allFiles
      .filter((f) => matchesProcessName(f.filename, processName))
      .slice(0, maxLogs);

    if (matching.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              processName,
              since: since ?? null,
              logsFound: 0,
              logsReturned: 0,
              logs: [],
            }),
          },
        ],
      };
    }

    const logs = await Promise.all(
      matching.map(async (f) => {
        let content = "";
        let fetchError: string | undefined;
        let truncated = false;
        let totalLines = 0;

        try {
          const raw = await tm1Client.server.getErrorLogContent(f.filename);
          const result = tailLines(raw, tail);
          content = result.body;
          truncated = result.truncated;
          totalLines = result.totalLines;
        } catch (e) {
          fetchError = (e as Error).message;
        }

        const entry: Record<string, unknown> = {
          filename: f.filename,
          totalLines,
          truncated,
          ...(fetchError ? { fetchError } : { content }),
        };

        if (includeRelated) {
          const sourceTs = tsFromFilename(f.filename);
          if (sourceTs === null) {
            entry.related = {
              note: "No embedded timestamp — cascade lookup skipped.",
              files: [],
            };
          } else {
            const related = await fetchRelatedLogs(
              tm1Client.server,
              allFiles,
              { filename: f.filename, ts: sourceTs },
              {
                windowSec: relatedWindowSec,
                maxFiles: relatedMaxFiles,
                maxBytes: DEFAULT_RELATED_MAX_BYTES,
              },
            );

            entry.related = {
              windowSec: relatedWindowSec,
              found: related.found,
              files: related.files.map((r) =>
                "error" in r
                  ? {
                      filename: r.filename,
                      deltaSec: r.deltaSec,
                      fetchError: r.error,
                    }
                  : {
                      filename: r.filename,
                      deltaSec: r.deltaSec,
                      truncated: r.truncated,
                      content: r.content,
                    },
              ),
            };
          }
        }

        return entry;
      }),
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            processName,
            since: since ?? null,
            logsFound: matching.length,
            logsReturned: logs.length,
            logs,
          }),
        },
      ],
    };
  },
});
