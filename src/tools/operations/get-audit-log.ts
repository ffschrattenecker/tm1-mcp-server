import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import { AuditLogEntrySchema } from "../schemas/items.js";
import { READ_ONLY, withVersion } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetAuditLog = defineTool({
  name: "tm1_get_audit_log",
  description:
    "Fetch recent TM1 audit log entries (metadata/security changes: who changed what, when), newest first. " +
    "Requires AuditLogOn=T in tm1s.cfg — an empty result on an active server usually means auditing is disabled " +
    "(check auditLogEnabled in tm1_get_server_info). (v11 only)",
  annotations: withVersion(READ_ONLY, "v11"),
  // v12 deprecated AuditLogEntry/AuditLogEntries in 12.0.0 and serves an empty
  // collection with no successor endpoint, so the tool can only mislead there.
  enabled: (tm1Client) => tm1Client.version === 11,
  output: {
    count: z.number().int(),
    entries: z.array(AuditLogEntrySchema),
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
    user: z.string().optional().describe("Filter to one user name"),
    objectType: z
      .string()
      .optional()
      .describe(
        "Filter to one object type, e.g. 'Cube', 'Dimension', 'Process', 'User', 'Chore', 'Server'",
      ),
    objectName: z.string().optional().describe("Filter to one object name"),
    since: z
      .string()
      .optional()
      .describe(
        "Only entries on or after this ISO timestamp, e.g. '2026-06-01T00:00:00Z'",
      ),
    until: z
      .string()
      .optional()
      .describe("Only entries on or before this ISO timestamp"),
    includeDetails: z
      .boolean()
      .optional()
      .default(false)
      .describe("Expand per-entry audit details (nested change records)"),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { top, user, objectType, objectName, since, until, includeDetails, format },
    tm1Client,
  ) => {
    const entries = await tm1Client.server.getAuditLog({
      top,
      user,
      objectType,
      objectName,
      since,
      until,
      includeDetails,
    });
    const payload = { count: entries.length, entries };
    type Row = (typeof entries)[number];
    const columns = columnsOf<Row>([
      "timestamp",
      "user",
      "objectType",
      "objectName",
      "description",
    ]);
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Audit log\n\n${p.count} entries\n\n${renderTable(p.entries, columns)}`,
    );
  },
});
