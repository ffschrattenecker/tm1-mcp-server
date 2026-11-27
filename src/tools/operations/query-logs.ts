import { z } from "zod";
import {
  TM1Error,
  TM1ErrorCode,
  type MessageLogEntry,
  type TransactionLogEntry,
} from "../../types.js";
import { normalizeLogTimestamp } from "../../tm1-client/services/server-service.js";
import {
  FORMAT_SCHEMA,
  columnsOf,
  payloadResponse,
  renderTable,
} from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { QueryLogsResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { extraSignal } from "../context.js";

const DEFAULT_TX_LOOKBACK_MINUTES = 60;
const DEFAULT_MSG_LOOKBACK_MINUTES = 1440;

type QueryLogsPayload = z.infer<typeof QueryLogsResultSchema>;

function renderLogsMarkdown(p: QueryLogsPayload): string {
  const title =
    p.logType === "transaction"
      ? "## Transaction Log Entries"
      : "## Message Log Entries";
  const header = `${title} (v${p.version})\n\nWindow: ${p.since}${p.until ? ` .. ${p.until}` : ""} · Showing ${p.count}${p.total !== null ? ` of ${p.total}` : ""}`;
  if (p.unavailable) {
    return `${header}\n\n> ${p.unavailable.message}`;
  }
  if (p.logType === "transaction") {
    const cols = columnsOf<TransactionLogEntry>([
      "timeStamp",
      "user",
      "cube",
      { header: "tuple", get: (e) => e.tuple.join(", ") },
      "oldValue",
      "newValue",
    ]);
    return `${header}\n\n${renderTable(p.items as TransactionLogEntry[], cols)}`;
  }
  const cols = columnsOf<MessageLogEntry>([
    "timeStamp",
    "level",
    "logger",
    "message",
    "threadId",
  ]);
  return `${header}\n\n${renderTable(p.items as MessageLogEntry[], cols)}`;
}

export const registerQueryLogs = defineTool({
  name: "tm1_query_logs",
  description: [
    "Query time-bounded TM1 TransactionLogEntries (cube/user/element cell changes) or MessageLogEntries (server/process log) on v11.",
    "Always bounds queries with a TimeStamp window to prevent full log scans. On v12 (where log entity sets are deprecated/empty), returns an explicit `unavailable` notice.",
  ],
  annotations: READ_ONLY,
  output: QueryLogsResultSchema,
  input: {
    logType: z
      .enum(["transaction", "message"])
      .describe(
        "Which TM1 log to query: 'transaction' (cell changes) or 'message' (server/process log).",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "ISO 8601 start timestamp (inclusive). Default: last 60 min for transaction logs, last 24h for message logs.",
      ),
    until: z
      .string()
      .optional()
      .describe("Optional ISO 8601 end timestamp (inclusive)."),
    lookbackMinutes: z
      .number()
      .int()
      .min(1)
      .max(43200)
      .optional()
      .describe(
        "Alternative to `since`: minutes back from now (ignored when `since` is given).",
      ),
    cubeName: z
      .string()
      .optional()
      .describe("Filter by cube name (logType='transaction' only)."),
    user: z
      .string()
      .optional()
      .describe("Filter by TM1 user name (logType='transaction' only)."),
    element: z
      .string()
      .optional()
      .describe(
        "Filter by element appearing anywhere in Tuple (logType='transaction' only).",
      ),
    level: z
      .enum(["FATAL", "ERROR", "WARN", "INFO", "DEBUG"])
      .optional()
      .describe("Filter by log level (logType='message' only)."),
    logger: z
      .string()
      .optional()
      .describe(
        "Substring filter on Logger, e.g. 'TM1.Process' or 'TM1.Lock' (logType='message' only).",
      ),
    search: z
      .string()
      .optional()
      .describe("Substring filter on Message text (logType='message' only)."),
    order: z
      .enum(["desc", "asc"])
      .optional()
      .default("desc")
      .describe("Sort order by TimeStamp (default 'desc', newest first)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(50)
      .describe("Max entries per page (1–500, default 50)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Entries to skip."),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe("Override default 30s timeout (ms)."),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    {
      logType,
      since,
      until,
      lookbackMinutes,
      cubeName,
      user,
      element,
      level,
      logger,
      search,
      order,
      limit,
      offset,
      timeoutMs,
      format,
    },
    tm1Client,
    extra,
  ) => {
    if (logType === "transaction" && (level || logger || search)) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "level, logger, and search filters only apply to logType='message'.",
        hint: "Use cubeName, user, or element for logType='transaction'.",
      });
    }
    if (logType === "message" && (cubeName || user || element)) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "cubeName, user, and element filters only apply to logType='transaction'.",
        hint: "Use level, logger, or search for logType='message'.",
      });
    }

    const defaultMinutes =
      logType === "transaction"
        ? DEFAULT_TX_LOOKBACK_MINUTES
        : DEFAULT_MSG_LOOKBACK_MINUTES;
    const resolvedSince = since
      ? normalizeLogTimestamp(since, "since")
      : normalizeLogTimestamp(
          new Date(
            Date.now() - (lookbackMinutes ?? defaultMinutes) * 60_000,
          ).toISOString(),
          "since",
        );
    const resolvedUntil = until
      ? normalizeLogTimestamp(until, "until")
      : undefined;

    if (resolvedUntil && resolvedSince > resolvedUntil) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `since (${resolvedSince}) must be <= until (${resolvedUntil}).`,
      });
    }

    if (tm1Client.version === 12) {
      const payload: QueryLogsPayload = {
        logType,
        version: 12,
        since: resolvedSince,
        ...(resolvedUntil ? { until: resolvedUntil } : {}),
        total: 0,
        count: 0,
        offset,
        has_more: false,
        next_offset: null,
        items: [],
        unavailable: {
          reason: "unsupported_v12",
          message:
            "TM1 v12 / Planning Analytics Engine deprecated TransactionLogEntries and MessageLogEntries (they always return empty). Use tm1_list_error_logs for TI/chore logs, or inspect logs via Planning Analytics Administration.",
        },
      };
      return payloadResponse(payload, format, renderLogsMarkdown);
    }

    const request = {
      signal: extraSignal(extra),
      ...(timeoutMs ? { timeoutMs } : {}),
    };

    try {
      const res =
        logType === "transaction"
          ? await tm1Client.server.queryTransactionLog({
              since: resolvedSince,
              ...(resolvedUntil ? { until: resolvedUntil } : {}),
              ...(cubeName ? { cubeName } : {}),
              ...(user ? { user } : {}),
              ...(element ? { element } : {}),
              top: limit,
              skip: offset,
              order,
              request,
            })
          : await tm1Client.server.queryMessageLog({
              since: resolvedSince,
              ...(resolvedUntil ? { until: resolvedUntil } : {}),
              ...(level ? { level } : {}),
              ...(logger ? { logger } : {}),
              ...(search ? { search } : {}),
              top: limit,
              skip: offset,
              order,
              request,
            });

      const count = res.entries.length;
      const total = res.total ?? null;
      const has_more =
        total !== null ? offset + count < total : count === limit;

      const payload: QueryLogsPayload = {
        logType,
        version: 11,
        since: resolvedSince,
        ...(resolvedUntil ? { until: resolvedUntil } : {}),
        total,
        count,
        offset,
        has_more,
        next_offset: has_more ? offset + count : null,
        items: res.entries,
      };
      return payloadResponse(payload, format, renderLogsMarkdown);
    } catch (err) {
      if (
        err instanceof TM1Error &&
        err.code === TM1ErrorCode.PERMISSION_DENIED
      ) {
        const payload: QueryLogsPayload = {
          logType,
          version: 11,
          since: resolvedSince,
          ...(resolvedUntil ? { until: resolvedUntil } : {}),
          total: 0,
          count: 0,
          offset,
          has_more: false,
          next_offset: null,
          items: [],
          unavailable: {
            reason: "denied",
            message: `Permission denied reading ${logType === "transaction" ? "TransactionLogEntries" : "MessageLogEntries"}: ${err.message}`,
          },
        };
        return payloadResponse(payload, format, renderLogsMarkdown);
      }
      throw err;
    }
  },
});
