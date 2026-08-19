import { z } from "zod";
import { READ_ONLY } from "../annotations.js";
import { ViewDefinitionResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerGetViewDefinition = defineTool({
  name: "tm1_get_view_definition",
  description: [
    "Return the structural definition of a cube view (MDX expression OR NativeView axes)",
    "WITHOUT executing it. Use tm1_get_view to execute and read cells.",
    "Auto-detects public vs private when isPrivate is omitted (public tried first).",
  ],
  annotations: READ_ONLY,
  output: ViewDefinitionResultSchema,
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    viewName: z.string().describe("Name of the view"),
    isPrivate: z
      .boolean()
      .optional()
      .describe(
        "If true, look only in PrivateViews. If false, only in Views. If omitted, public is tried first then private.",
      ),
  },
  handler: async ({ cubeName, viewName, isPrivate }, tm1Client) => {
    const result = await tm1Client.views.getDefinition(
      cubeName,
      viewName,
      isPrivate,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  },
});
