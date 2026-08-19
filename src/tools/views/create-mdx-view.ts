import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCreateMdxView = defineTool({
  name: "tm1_create_mdx_view",
  description:
    "Create a public MDX-based view on a cube. The view persists server-side and can be used as a TI process datasource (TM1CubeView) or executed via tm1_get_view.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube the view belongs to"),
    viewName: z.string().describe("New view name"),
    mdx: z.string().describe("MDX SELECT query defining the view"),
  },
  handler: async ({ cubeName, viewName, mdx }, tm1Client) => {
    await tm1Client.views.createMdx(cubeName, viewName, mdx);
    return actionResponse({ success: true, cubeName, viewName });
  },
});
