// Monitoring/server-domain schemas: server info & state, message/transaction/
// audit/error logs, threads, jobs and sessions.
import { z } from "zod";

// Canonical shapes — defined once in src/schemas/monitoring.ts, re-exported so
// the output-schema side and the TM1 client cannot drift apart.
export {
  AuditLogDetailSchema,
  ErrorLogFileSchema,
  JobSchema,
  MessageLogEntrySchema,
  SessionSchema,
  ThreadSchema,
  TransactionLogEntrySchema,
} from "../../schemas/monitoring.js";
import { AuditLogDetailSchema } from "../../schemas/monitoring.js";

export const ServerInfoSchema = z
  .object({
    mcpServer: z.object({ name: z.string(), version: z.string() }).optional(),
    serverName: z.string(),
    productVersion: z.string(),
    productEdition: z.string().optional(),
    adminHost: z.string().optional(),
    dataDirectory: z.string().optional(),
    timeZoneId: z.string().optional(),
    integratedSecurityMode: z.string().optional(),
    modelling: z.unknown().optional(),
    ti: z.unknown().optional(),
    rules: z.unknown().optional(),
    mtq: z.unknown().optional(),
    jobQueuing: z.unknown().optional(),
    memory: z.unknown().optional(),
    logging: z.unknown().optional(),
    http: z.unknown().optional(),
    security: z.unknown().optional(),
    _raw: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const AuditLogEntrySchema = AuditLogDetailSchema.extend({
  details: z.array(AuditLogDetailSchema).optional(),
});

// groupBy='process' audit-summary item: per-process failure aggregation.
export const ErrorLogGroupSchema = z.object({
  process: z.string(),
  count: z.number().int(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  spanDays: z.number().int(),
  perDay: z.number(),
});

const RelatedErrorLogFileSchema = z.object({
  filename: z.string(),
  deltaSec: z.number().int(),
  totalBytes: z.number().int().optional(),
  returnedBytes: z.number().int().optional(),
  truncated: z.boolean().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
});

export const ErrorLogContentResultSchema = z.object({
  filename: z.string(),
  totalBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  content: z.string(),
  related: z
    .object({
      windowSec: z.number().int().optional(),
      found: z.number().int().optional(),
      maxFiles: z.number().int().optional(),
      note: z.string().optional(),
      files: z.array(RelatedErrorLogFileSchema),
    })
    .optional(),
});

// Server state snapshot curates a few config flags whose surface differs
// per TM1 build — every section is permissive (.passthrough()).
export const ServerStateResultSchema = z
  .object({
    connected: z.boolean(),
    server: z.unknown(),
    capabilities: z.unknown(),
    counts: z.unknown(),
  })
  .passthrough();
