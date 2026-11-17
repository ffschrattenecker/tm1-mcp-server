// File-operation schemas: bare filename list item.
import { z } from "zod";

// listFiles returns bare strings (file/folder names).
export const FilenameItemSchema = z.string();

// tm1_read_server_file result: lines of a server file read through TI (v11).
export const ServerFileReadResultSchema = z.object({
  path: z.string(),
  lineCount: z.number().int(),
  truncated: z.boolean(),
  encoding: z.enum(["utf-8", "windows-1252"]),
  lines: z.array(z.string()),
});
