import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { actionResponse, jsonError } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { CONTAINER_SCHEMA } from "./container.js";
import { validationError } from "./files-read.js";

const HARD_MAX_BYTES = 32 * 1024 * 1024;

// Upload, delete and create_folder share one tool so the readonly gate in defineTool covers
// both with a single non-READ_ONLY annotation; DESTRUCTIVE because either op
// can lose a server file (upload silently replaces one of the same name).
export const registerFilesWrite = defineTool({
  name: "tm1_files_write",
  description: [
    "Change the TM1 server's file storage.",
    "op='upload' creates or replaces fileName.",
    `Hard max ${HARD_MAX_BYTES} bytes (32 MB).`,
    "op='delete': remove fileName, or a folder only when it is empty (one holding entries is refused). Irreversible; NOT_FOUND if missing in both containers.",
    "op='create_folder': create the folder fileName, one level per call; an existing folder answers created=false. 'files' nests on v12 only (v11: UNSUPPORTED_OPERATION); 'applications' on both.",
    "The parent folder must already exist; container='applications' takes no document directly under its root.",
    "Every op needs confirm (upload replaces a same-named file).",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    op: z.enum(["upload", "delete", "create_folder"]),
    fileName: z
      .string()
      .min(1)
      .describe(
        "File or folder name or path (e.g. 'data.csv' or 'imports/sales_2024.csv'). v11 'files' = flat only.",
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
    if (op !== "upload" && content !== undefined) {
      throw validationError(
        `content does not apply to op="${op}". Nothing was changed.`,
        'Drop content, or use op="upload" to write a file.',
      );
    }
    if (op === "create_folder") {
      requireConfirm(confirm, fileName, "folder");
      const { created } = await withToolHint(
        tm1Client.files.createFolder(fileName, container),
        'One level per call: the parent folder must exist, and the name must not be taken by a file. List a level with tm1_files_read op="list" and the same container.',
      );
      return actionResponse({
        success: true,
        fileName,
        container,
        created,
      });
    }
    if (op === "delete") {
      requireConfirm(confirm, fileName, "file");
      await withToolHint(
        tm1Client.files.delete(fileName, container),
        'Verify the name with tm1_files_read op="list" or op="search". Case does not matter; the path does.',
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
      return jsonError({
        code: "VALIDATION_ERROR",
        message: `File too large: ${bytes.byteLength} bytes (hard max ${HARD_MAX_BYTES})`,
        hint: "Split the file or upload a smaller subset. Multipart upload is not yet supported.",
      });
    }

    const result = await withToolHint(
      tm1Client.files.upload(fileName, bytes, container),
      "The parent folder must already exist; create it with op='create_folder'. v11 'files' is flat, so a subfolder needs v12. container='applications' refuses a document directly under its root: name a folder in fileName.",
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
