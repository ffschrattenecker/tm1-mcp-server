// Monitoring domain: threads (v11), jobs (v12), sessions and the log entries.
import { z } from "zod";
import { CellValueSchema } from "./common.js";

const TransactionLogEntrySchema = z.object({
  timestamp: z.string(),
  user: z.string(),
  cubeName: z.string(),
  elements: z.array(z.string()),
  oldValue: CellValueSchema,
  newValue: CellValueSchema,
});
export type TransactionLogEntry = z.infer<typeof TransactionLogEntrySchema>;

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
  lastUpdated: z.string().optional(),
});
export type ErrorLogFile = z.infer<typeof ErrorLogFileSchema>;
