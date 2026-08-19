import { z } from "zod";
import { withToolHint } from "../error-format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerDeleteFile = defineTool({
  name: "tm1_delete_file",
  description: [
    "Delete a file from the TM1 server's blob/file storage.",
    "Irreversible — file is removed from Files/Blobs container.",
    "Auto-falls back from v12 (Files) to v11 (Blobs).",
    "Returns NOT_FOUND if file is missing in both containers.",
    "Safety: pass confirm=<file name verbatim>.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    fileName: z
      .string()
      .min(1)
      .describe("File name or path (e.g. 'data.csv' or 'imports/old.csv')."),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ fileName, confirm }, tm1Client) => {
    requireConfirm(confirm, fileName, "file");
    await withToolHint(
      tm1Client.files.delete(fileName),
      "Verify exact name with tm1_list_files or tm1_search_files. Names are case-sensitive.",
    );
    return actionResponse({ success: true, fileName, deleted: true });
  },
});
