import { z } from "zod";
import { actionResponse } from "../format.js";
import { CopyProcessResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
export const registerCopyProcess = defineTool({
  name: "tm1_copy_process",
  description:
    "Copy a TI process to a new name. Carries over code, parameters, variables, datasource and the " +
    "UI-only state — including which datasource columns are set to Ignore. Never overwrites: an existing targetName fails with CONFLICT.",
  annotations: WRITE,
  output: CopyProcessResultSchema,
  input: {
    sourceName: z.string().describe("Name of the source TI process"),
    targetName: z.string().describe("Name for the new copy"),
  },
  handler: async ({ sourceName, targetName }, tm1Client) => {
    // TM1 refuses the POST itself ("already exists", 400) and leaves the
    // target untouched — verified live on 11.8. Checking first turns that
    // generic 400 into a CONFLICT that says what to do.
    if (await tm1Client.processes.exists(targetName)) {
      throw new TM1Error({
        code: TM1ErrorCode.CONFLICT,
        message: `Process '${targetName}' already exists; copy_process never overwrites.`,
        hint: "Pick a new targetName, or deploy onto the existing process with tm1_upsert_process.",
      });
    }
    await tm1Client.processes.copy(sourceName, targetName);
    return actionResponse({ success: true, sourceName, targetName });
  },
});
