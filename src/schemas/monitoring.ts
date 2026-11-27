// Monitoring domain: error logs, live activity/sessions, and transaction/message logs.
import { z } from "zod";
import { CellValueSchema } from "./common.js";

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
});
export type ErrorLogFile = z.infer<typeof ErrorLogFileSchema>;

export const ActivityLocksSchema = z.object({
  read: z.number().int(),
  intentWrite: z.number().int(),
  write: z.number().int(),
});

export const ActivityItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["thread", "job"]),
  user: z.string().nullable(),
  state: z.string(),
  operation: z.string(),
  context: z.string().optional(),
  threadType: z.string().optional(),
  objectType: z.string().optional(),
  objectName: z.string().optional(),
  elapsedTime: z.string().optional(),
  waitTime: z.string().optional(),
  elapsedSeconds: z.number().optional(),
  waitSeconds: z.number().optional(),
  locks: ActivityLocksSchema.optional(),
  waitingOn: z.array(z.string()).optional(),
  info: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const SessionItemSchema = z.object({
  id: z.string(),
  user: z.string().nullable(),
  friendlyName: z.string().optional(),
  active: z.boolean().optional(),
  context: z.string().optional(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

export const TransactionLogEntrySchema = z.object({
  id: z.number().optional(),
  changeSetId: z.string().optional(),
  timeStamp: z.string(),
  user: z.string(),
  cube: z.string(),
  tuple: z.array(z.string()),
  oldValue: CellValueSchema,
  newValue: CellValueSchema,
});
export type TransactionLogEntry = z.infer<typeof TransactionLogEntrySchema>;

export const MessageLogEntrySchema = z.object({
  id: z.number().optional(),
  timeStamp: z.string(),
  level: z.string(),
  logger: z.string(),
  message: z.string(),
  threadId: z.number().int().optional(),
  sessionId: z.number().int().optional(),
});
export type MessageLogEntry = z.infer<typeof MessageLogEntrySchema>;
