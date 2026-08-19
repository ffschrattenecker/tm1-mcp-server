import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { TransactionLogEntrySchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerGetTransactionLog = defineTool({
  name: "tm1_get_transaction_log",
  description:
    "Fetch recent TM1 transaction log entries (cell writes), newest first. Optional filters: cube, user, and a since/until time range. NOTE: the endpoint scans the log server-side and a full scan can take minutes-to-hours. A cheap preflight probe fails fast on unreachable/no-rights; without `since` the server walks expanding time windows backward (10min→1y) and stops once `top` rows are found, so it never triggers a full scan. Pass since/until (from-to) to bound it explicitly.",
  annotations: READ_ONLY,
  output: {
    count: z.number().int(),
    coverage: z
      .enum(["complete", "partial"])
      .describe("partial=hit top, more may exist earlier"),
    scannedFrom: z.string().describe("earliest timestamp scanned"),
    entries: z.array(TransactionLogEntrySchema),
  },
  input: {
    top: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(100)
      .describe("Max entries to return (default: 100, max: 1000)"),
    cubeName: z.string().optional().describe("Filter to one cube"),
    user: z.string().optional().describe("Filter to one user"),
    since: z
      .string()
      .optional()
      .describe(
        "Lower bound — only entries on or after this timestamp (UTC). Date '2026-04-17' or datetime '2026-04-17T00:00:00' (a 'Z' is added if missing). When omitted, expanding backward windows are used instead of a full scan.",
      ),
    until: z
      .string()
      .optional()
      .describe(
        "Upper bound — only entries on or before this timestamp (UTC). Same format as since. Combine with since for an explicit from-to range; with neither, the window anchor is now.",
      ),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ top, cubeName, user, since, until, format }, tm1Client) => {
    const { entries, coverage, scannedFrom } =
      await tm1Client.server.getTransactionLog({
        top,
        cubeName,
        user,
        since,
        until,
      });
    const payload = { count: entries.length, coverage, scannedFrom, entries };
    type Row = (typeof entries)[number];
    const columns = columnsOf<Row>([
      "timestamp",
      "user",
      { header: "cube", get: (e) => e.cubeName },
      "elements",
      { header: "old", get: (e) => e.oldValue },
      { header: "new", get: (e) => e.newValue },
    ]);
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Transaction log\n\n${p.count} entries (coverage: ${p.coverage}, scanned back to ${p.scannedFrom})\n\n${renderTable(p.entries, columns)}`,
    );
  },
});
