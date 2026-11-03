// A .pro file handed over either as a host `filePath` or as inline `content`,
// parsed once. Shared by the tools that read a .pro body (import, diff, validate
// refs), so the input fields and the "which source" rule live in one place.
import { promises as fs } from "node:fs";
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";
import { resolveLocalPath } from "../local-file.js";

export const PRO_SOURCE_SCHEMA = {
  filePath: z
    .string()
    .optional()
    .describe(
      "Absolute path to the .pro file on the MCP server host. Otherwise pass 'content' inline.",
    ),
  content: z
    .string()
    .optional()
    .describe("Raw .pro file content as string (alternative to filePath)"),
};

/** Reads and parses the .pro body: `content` wins, else `filePath`. */
export async function loadProSource({
  filePath,
  content,
}: {
  filePath?: string | undefined;
  content?: string | undefined;
}): Promise<ReturnType<typeof parseProFile>> {
  if (!filePath && !content) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: "Provide filePath or content",
    });
  }
  const body = content
    ? content
    : await fs.readFile(resolveLocalPath(filePath!), "utf8");
  return parseProFile(body);
}
