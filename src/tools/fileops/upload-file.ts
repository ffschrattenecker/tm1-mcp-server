import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

const HARD_MAX_BYTES = 32 * 1024 * 1024;

export const registerUploadFile = defineTool({
  name: "tm1_upload_file",
  description: [
    "Upload (create or update) a file in the TM1 server's blob/file storage.",
    "Use to push CSV, TXT, or other data files that import processes will read.",
    "Provide content as plain text OR base64 (set encoding='base64' for binary).",
    "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
    "v11: subfolders not supported — use a flat file name. v12: nested paths OK if folders exist.",
    `Hard max size: ${HARD_MAX_BYTES} bytes (32 MB).`,
  ],
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    fileName: z
      .string()
      .min(1)
      .describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv'). v11 = flat only.",
      ),
    content: z
      .string()
      .describe(
        "File content. Plain text by default, or base64 string when encoding='base64'.",
      ),
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe(
        "Encoding of the `content` field. 'text' (default) for UTF-8 text, 'base64' for binary.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ fileName, content, encoding, confirm }, tm1Client) => {
    // Silently replaces an existing server file of the same name. Guards
    // against accidental invocation — not a security control.
    requireConfirm(confirm, fileName, "file");
    const bytes =
      encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");

    if (bytes.byteLength > HARD_MAX_BYTES) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                code: "VALIDATION_ERROR",
                message: `File too large: ${bytes.byteLength} bytes (hard max ${HARD_MAX_BYTES})`,
                hint: "Split the file or upload a smaller subset. Multipart upload is not yet supported.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const result = await withToolHint(
      tm1Client.files.upload(fileName, bytes),
      "If parent folder is missing, create it on TM1 v12 before retrying. v11 supports root only.",
    );

    return actionResponse({
      success: true,
      fileName,
      bytesUploaded: bytes.byteLength,
      created: result.created,
      updated: !result.created,
      container: result.root,
    });
  },
});
