import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import { MessageLogEntrySchema } from "../schemas/items.js";
import { READ_ONLY, withVersion } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetMessageLog = defineTool({
  name: "tm1_get_message_log",
  description:
    "Fetch recent TM1 server message log entries, newest first. Useful for debugging TI process errors. The `filter`/`level`/`since` filters are applied SERVER-SIDE, so a matching entry is found even when it is older than the newest `top` rows (no false 'no error found'). When an entry references a TI error file, the parsed filename is surfaced as `errorFile` — pass it straight to tm1_get_error_log_content to read the failure detail. (v11 only)",
  annotations: withVersion(READ_ONLY, "v11"),
  // v12 deprecated MessageLogEntry/MessageLogEntries (and the MessageLog /
  // TailMessageLog functions) in 12.0.0; all of them serve empty with no
  // successor endpoint.
  enabled: (tm1Client) => tm1Client.version === 11,
  output: {
    count: z.number().int(),
    entries: z.array(MessageLogEntrySchema),
  },
  input: {
    top: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe(
        "Number of entries to fetch (default: 100, max: 500). Applied AFTER the filters, so a filter still finds older matches beyond the newest 500 rows.",
      ),
    filter: z
      .string()
      .optional()
      .describe(
        "Optional text filter — only entries whose message contains this string are returned (case-insensitive). Pushed to the server, so matches older than `top` are found.",
      ),
    level: z
      .string()
      .optional()
      .describe("Optional exact level filter, e.g. 'ERROR', 'WARN', 'INFO'."),
    since: z
      .string()
      .optional()
      .describe(
        "Only entries on or after this timestamp (UTC). Date '2026-06-01' or datetime '2026-06-01T00:00:00' (a 'Z' is added if missing).",
      ),
    until: z
      .string()
      .optional()
      .describe(
        "Only entries on or before this timestamp (UTC). Same format as since.",
      ),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ top, filter, level, since, until, format }, tm1Client) => {
    const filtered = await tm1Client.server.getMessageLog({
      top,
      filter,
      level,
      since,
      until,
    });
    const payload = { count: filtered.length, entries: filtered };
    type Row = (typeof filtered)[number];
    const columns = columnsOf<Row>([
      "timestamp",
      "level",
      "message",
      "errorFile",
    ]);
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Message log\n\n${p.count} entries\n\n${renderTable(p.entries, columns)}`,
    );
  },
});
