import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerDeleteHierarchy = defineTool({
  name: "tm1_delete_hierarchy",
  description:
    "Delete a hierarchy from a dimension. Irreversible — pass confirm=<hierarchy name verbatim>. Deleting the same-named (default) hierarchy is allowed: TM1 makes another hierarchy the default, and a bare [Dim] in MDX then resolves to it. The tools of this server still default an omitted hierarchyName to the dimension name, so after such a delete pass hierarchyName on every call.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z.string().describe("Hierarchy name to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ dimensionName, hierarchyName, confirm }, tm1Client) => {
    requireConfirm(confirm, hierarchyName, "hierarchy");
    await tm1Client.hierarchies.delete(dimensionName, hierarchyName);
    return actionResponse({ success: true, dimensionName, hierarchyName });
  },
});
