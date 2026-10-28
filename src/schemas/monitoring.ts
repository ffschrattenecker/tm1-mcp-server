// Error log file entries: the shape the TM1 client returns and the tools publish.
import { z } from "zod";

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
});
export type ErrorLogFile = z.infer<typeof ErrorLogFileSchema>;
