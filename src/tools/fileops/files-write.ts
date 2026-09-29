import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { CONTAINER_SCHEMA } from "./container.js";

const HARD_MAX_BYTES = 32 * 1024 * 1024;

function validationError(message: string, hint: string): TM1Error {
  return new TM1Error({ code: TM1ErrorCode.VALIDATION_ERROR, message, hint });
}

// Upload and delete share one tool so the readonly gate in defineTool covers
// both with a single non-READ_ONLY annotation; DESTRUCTIVE because either op
// can lose a server file (upload silently replaces one of the same name).
export const registerFilesWrite = defineTool({
  name: "tm1_files_write",
  description: [
    "Change the TM1 server's file storage (TI data directory: Files on v12, Blobs on v11; auto-fallback).",
    "op='upload': create or replace fileName with content (plain text, or base64 with encoding='base64' for binary). v11: flat names only; v12: nested paths OK if the folders exist.",
    `Hard max ${HARD_MAX_BYTES} bytes (32 MB).`,
    "op='delete': remove fileName; irreversible, NOT_FOUND if missing in both containers.",
    "container='applications' targets the Applications tree instead, which nests on both versions; the parent folder must already exist.",
    "Safety: both ops need confirm=<fileName verbatim>.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    op: z.enum(["upload", "delete"]),
    fileName: z
      .string()
      .min(1)
      .describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv'). v11 = flat only.",
      ),
    content: z
      .string()
      .optional()
      .describe(
        "upload (required): file content; plain text, or base64 when encoding='base64'.",
      ),
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe("upload: encoding of content; 'base64' for binary."),
    ...CONTAINER_SCHEMA,
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { op, fileName, content, encoding, container, confirm },
    tm1Client,
  ) => {
    if (op === "delete") {
      if (content !== undefined) {
        throw validationError(
          'content does not apply to op="delete". Nothing was deleted.',
          'Drop content to delete the file, or use op="upload" to replace it.',
        );
      }
      requireConfirm(confirm, fileName, "file");
      await withToolHint(
        tm1Client.files.delete(fileName, container),
        'Verify the exact name with tm1_files_read op="list" or op="search". Names are case-sensitive.',
      );
      return actionResponse({ success: true, fileName, deleted: true });
    }

    // op === "upload"
    if (content === undefined) {
      throw validationError(
        'op="upload" needs content. Nothing was written.',
        "Pass content as text, or as base64 with encoding='base64'.",
      );
    }
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
      tm1Client.files.upload(fileName, bytes, container),
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
