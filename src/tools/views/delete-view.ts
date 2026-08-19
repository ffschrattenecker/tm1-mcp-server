import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerDeleteView = defineTool({
  name: "tm1_delete_view",
  description:
    "Delete a public view from a cube. Irreversible — pass confirm=<view name verbatim>.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube name"),
    viewName: z.string().describe("View name to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, viewName, confirm }, tm1Client) => {
    requireConfirm(confirm, viewName, "view");
    await tm1Client.views.delete(cubeName, viewName);
    return actionResponse({ success: true, cubeName, viewName });
  },
});
