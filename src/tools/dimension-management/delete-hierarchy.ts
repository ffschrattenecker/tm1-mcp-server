import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { tm1NameEquals } from "../../lib/tm1-name.js";

export const registerDeleteHierarchy = defineTool({
  name: "tm1_delete_hierarchy",
  description:
    "Delete a hierarchy from a dimension. Irreversible — pass confirm=<hierarchy name verbatim>. Deleting the same-named (default) hierarchy is allowed. The tools of this server still default an omitted hierarchyName to the dimension name, so after such a delete pass hierarchyName on every call.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z.string().describe("Hierarchy name to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ dimensionName, hierarchyName, confirm }, tm1Client) => {
    requireConfirm(confirm, hierarchyName, "hierarchy");
    // TM1 does NOT refuse this itself: 11.8 answers 204 and leaves a dimension
    // listed with no hierarchies at all (verified live). Refuse it here.
    if (tm1NameEquals(hierarchyName, dimensionName)) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `'${hierarchyName}' is the default hierarchy of '${dimensionName}' and cannot be deleted on its own.`,
        hint: "Delete the whole dimension with tm1_delete_dimension, or name an alternate hierarchy.",
      });
    }
    await tm1Client.hierarchies.delete(dimensionName, hierarchyName);
    return actionResponse({ success: true, dimensionName, hierarchyName });
  },
});
