import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCreateHierarchy = defineTool({
  name: "tm1_create_hierarchy",
  description:
    "Create a new (alternate) hierarchy inside an existing dimension. The dimension's default hierarchy already has the same name as the dimension — use this for additional rollup structures.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Existing dimension name"),
    hierarchyName: z
      .string()
      .describe("New hierarchy name (must differ from existing hierarchies)"),
  },
  handler: async ({ dimensionName, hierarchyName }, tm1Client) => {
    await tm1Client.hierarchies.create(dimensionName, hierarchyName);
    return actionResponse({ success: true, dimensionName, hierarchyName });
  },
});
