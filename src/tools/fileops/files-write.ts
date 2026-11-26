import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { actionResponse, jsonError } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { extraSignal } from "../context.js";
import { CONTAINER_SCHEMA } from "./container.js";
import { validationError } from "./files-read.js";
import { resolveLocalPath } from "../local-file.js";

const HARD_MAX_BYTES = 32 * 1024 * 1024;

// Upload, delete and create_folder share one tool so the readonly gate in
// defineTool covers them with a single non-READ_ONLY annotation; DESTRUCTIVE
// because upload and delete can lose a server file.
export const registerFilesWrite = defineTool({
  name: "tm1_files_write",
  description: [
    "Change the TM1 server's file storage.",
    "op='upload' creates or replaces fileName; in container='applications' an existing document is only replaced with overwrite=true (CONFLICT otherwise).",
    "Pass content, or sourcePath to send a file from the MCP host byte-for-byte — the way to upload a spreadsheet without its bytes passing through the conversation.",
    `Hard max ${HARD_MAX_BYTES} bytes (32 MB). The upload is read back and compared by SHA-256: verified=false means the read-back differed or failed, so the upload is unconfirmed.`,
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
        "upload: file content; plain text, or base64 when encoding='base64'. Alternative to sourcePath.",
      ),
    sourcePath: z
      .string()
      .optional()
      .describe(
        "upload: absolute path of a file on the MCP host, sent unchanged (alternative to content; encoding is ignored). Must lie inside TM1_LOCAL_FILE_ROOT when that is set; required over HTTP.",
      ),
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe("upload: encoding of content; 'base64' for binary."),
    ...CONTAINER_SCHEMA,
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "upload, container='applications' only: replace a document that already exists (default false refuses it). The 'files' container always replaces.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    {
      op,
      fileName,
      content,
      sourcePath,
      encoding,
      container,
      overwrite,
      confirm,
    },
    tm1Client,
    extra,
  ) => {
    const signal = extraSignal(extra);
    const reqOpts = signal ? { signal } : undefined;
    for (const [field, value] of Object.entries({
      content,
      sourcePath,
      overwrite,
    })) {
      if (op !== "upload" && value !== undefined) {
        throw validationError(
          `${field} does not apply to op="${op}". Nothing was changed.`,
          `Drop ${field}, or use op="upload" to write a file.`,
        );
      }
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
    if ((content === undefined) === (sourcePath === undefined)) {
      throw validationError(
        'op="upload" needs exactly one of content or sourcePath. Nothing was written.',
        "Pass content as text (or base64 with encoding='base64'), or sourcePath for a file on the MCP host.",
      );
    }
    // Silently replaces an existing server file of the same name. Guards
    // against accidental invocation — not a security control.
    requireConfirm(confirm, fileName, "file");
    const tooLarge = (size: number) =>
      jsonError({
        code: "VALIDATION_ERROR",
        message: `File too large: ${size} bytes (hard max ${HARD_MAX_BYTES})`,
        hint: "Split the file or upload a smaller subset. Multipart upload is not yet supported.",
      });
    let bytes: Buffer;
    if (sourcePath !== undefined) {
      const resolved = resolveLocalPath(sourcePath, "sourcePath");
      // Asked before the read, so an oversized file is never loaded whole.
      const { size } = await fs.stat(resolved);
      if (size > HARD_MAX_BYTES) return tooLarge(size);
      bytes = await fs.readFile(resolved);
    } else {
      bytes = Buffer.from(
        content ?? "",
        encoding === "base64" ? "base64" : "utf8",
      );
    }
    if (bytes.byteLength > HARD_MAX_BYTES) return tooLarge(bytes.byteLength);

    const result = await withToolHint(
      tm1Client.files.upload(
        fileName,
        bytes,
        container,
        overwrite ?? false,
        ...(reqOpts ? [reqOpts] : []),
      ),
      "The parent folder must already exist; create it with op='create_folder'. v11 'files' is flat, so a subfolder needs v12. container='applications' refuses a document directly under its root: name a folder in fileName.",
    );

    // Every route writes in two requests and the PUT answers with no body, so
    // only a read tells whether the server holds these bytes. A failed read
    // leaves the upload standing and reports it as unverified.
    const sha256 = sha256Of(bytes);
    const verified = await tm1Client.files
      .getContentBytes(fileName, container, ...(reqOpts ? [reqOpts] : []))
      .then((back) => sha256Of(back) === sha256)
      .catch(() => false);

    return actionResponse({
      success: true,
      fileName,
      bytesUploaded: bytes.byteLength,
      sha256,
      verified,
      created: result.created,
      updated: !result.created,
      container: result.root,
    });
  },
});

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
