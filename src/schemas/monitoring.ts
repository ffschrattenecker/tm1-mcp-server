// Monitoring domain: threads (v11), jobs (v12), sessions and the log entries.
import { z } from "zod";
import { CellValueSchema } from "./common.js";

export const ThreadSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  state: z.string(),
  function: z.string(),
  objectName: z.string(),
  elapsedTime: z.string().optional(),
  objectType: z.string().optional(),
  waitTime: z.string().optional(),
  info: z.string().optional(),
  context: z.string().optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  user: z.string(),
  active: z.boolean().optional(),
  threads: z.array(ThreadSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export const JobSessionSchema = z.object({
  id: z.string(),
  context: z.string().optional(),
  user: z.string().optional(),
});
export type JobSession = z.infer<typeof JobSessionSchema>;

export const JobWaitingOnSchema = z.object({
  id: z.string(),
  description: z.string(),
  state: z.string(),
});
export type JobWaitingOn = z.infer<typeof JobWaitingOnSchema>;

export const JobSchema = z.object({
  id: z.string(),
  description: z.string(),
  state: z.string(),
  elapsedTime: z.string().optional(),
  waitTime: z.string().optional(),
  session: JobSessionSchema.optional(),
  waitingOn: z.array(JobWaitingOnSchema).optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const MessageLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  /** TI error file referenced in `message`, parsed out for direct fetch. */
  errorFile: z.string().optional(),
});
export type MessageLogEntry = z.infer<typeof MessageLogEntrySchema>;

export const TransactionLogEntrySchema = z.object({
  timestamp: z.string(),
  user: z.string(),
  cubeName: z.string(),
  elements: z.array(z.string()),
  oldValue: CellValueSchema,
  newValue: CellValueSchema,
});
export type TransactionLogEntry = z.infer<typeof TransactionLogEntrySchema>;

export const AuditLogDetailSchema = z.object({
  id: z.number().int(),
  timestamp: z.string(),
  user: z.string(),
  description: z.string(),
  objectType: z.string(),
  objectName: z.string(),
});
export type AuditLogDetail = z.infer<typeof AuditLogDetailSchema>;

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
  lastUpdated: z.string().optional(),
});
export type ErrorLogFile = z.infer<typeof ErrorLogFileSchema>;
