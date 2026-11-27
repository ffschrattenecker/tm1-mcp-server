// Monitoring/server-domain schemas: server state, error logs, activity, security, query logs.
import { z } from "zod";
import {
  ActivityItemSchema,
  ErrorLogFileSchema,
  MessageLogEntrySchema,
  SessionItemSchema,
  TransactionLogEntrySchema,
} from "../../schemas/monitoring.js";
import { ObjectSecurityRightSchema } from "../../schemas/security.js";

// Canonical shapes — defined once in src/schemas/, re-exported so
// the output-schema side and the TM1 client cannot drift apart.
export {
  ActivityItemSchema,
  ErrorLogFileSchema,
  MessageLogEntrySchema,
  ObjectSecurityRightSchema,
  SessionItemSchema,
  TransactionLogEntrySchema,
};

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

export const ActivitySnapshotResultSchema = z.object({
  version: z.union([z.literal(11), z.literal(12)]),
  source: z.enum(["Threads", "Jobs"]),
  summary: z.object({
    totalActivities: z.number().int(),
    activeCount: z.number().int(),
    waitingCount: z.number().int(),
    idleOmitted: z.number().int(),
    sessionCount: z.number().int().nullable(),
    hasContention: z.boolean(),
    lockHolders: z.array(z.string()),
    waiters: z.array(z.string()),
    longestElapsedSeconds: z.number().nullable(),
    longestWaitSeconds: z.number().nullable(),
  }),
  activities: z.array(ActivityItemSchema),
  sessions: z.array(SessionItemSchema).optional(),
  warnings: z.array(z.string()).optional(),
});

export const SecuritySectionSchema = z.object({
  securityCubeExists: z.boolean(),
  dimensionName: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
  items: z.array(ObjectSecurityRightSchema),
});

export const SecurityInspectionResultSchema = z.object({
  user: z.object({
    name: z.string(),
    friendlyName: z.string().optional(),
    type: z.string().optional(),
    enabled: z.boolean().optional(),
    groups: z.array(z.string()),
    isAdmin: z.boolean(),
    specialGroups: z.array(z.string()),
  }),
  cubes: SecuritySectionSchema.optional(),
  dimensions: SecuritySectionSchema.optional(),
  elements: SecuritySectionSchema.optional(),
  processes: SecuritySectionSchema.optional(),
  warnings: z.array(z.string()).optional(),
});

export const QueryLogsResultSchema = z.object({
  logType: z.enum(["transaction", "message"]),
  version: z.union([z.literal(11), z.literal(12)]),
  since: z.string(),
  until: z.string().optional(),
  total: z.number().int().nullable(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  items: z.array(z.union([TransactionLogEntrySchema, MessageLogEntrySchema])),
  unavailable: z
    .object({
      reason: z.enum(["unsupported_v12", "denied"]),
      message: z.string(),
    })
    .optional(),
});
