import { z } from "zod";
import { actionResponse } from "../format.js";
import { CopyProcessResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
export const registerCopyProcess = defineTool({
  name: "tm1_copy_process",
  description:
    "Copy a TI process to a new name. Carries over code, parameters, variables, datasource and the " +
    "UI-only state — including which datasource columns are set to Ignore.",
  annotations: WRITE,
  output: CopyProcessResultSchema,
  input: {
    sourceName: z.string().describe("Name of the source TI process"),
    targetName: z.string().describe("Name for the new copy"),
  },
  handler: async ({ sourceName, targetName }, tm1Client) => {
    await tm1Client.processes.copy(sourceName, targetName);
    return actionResponse({ success: true, sourceName, targetName });
  },
});
