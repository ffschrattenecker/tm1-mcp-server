import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { HIERARCHY_NAME_OPTIONAL, resolveHierarchy } from "../hierarchy.js";

export const registerDeleteElements = defineTool({
  name: "tm1_delete_elements",
  description: [
    "Delete many elements from one TM1 dimension hierarchy in a single call ($batch where the server supports it).",
    "Not all-or-nothing: each element reports deleted or its error, and success is true only when every one was deleted. Irreversible — pass confirm=<dimension name verbatim>.",
    "For one element tm1_delete_element works too.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the dimension"),
    ...HIERARCHY_NAME_OPTIONAL,
    elementNames: z
      .array(z.string())
      .min(1)
      .max(5000)
      .describe("Elements to delete"),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { dimensionName, hierarchyName, elementNames, confirm },
    tm1Client,
  ) => {
    requireConfirm(confirm, dimensionName, "dimension");
    const hierarchy = resolveHierarchy(dimensionName, hierarchyName);
    const results = await tm1Client.elements.deleteMany(
      dimensionName,
      hierarchy,
      elementNames,
    );
    const failures = results.filter((r) => !r.deleted);
    return actionResponse({
      success: failures.length === 0,
      dimensionName,
      hierarchyName: hierarchy,
      deleted: results.length - failures.length,
      failed: failures.length,
      // Only the failures carry detail; listing every deleted name back would
      // just echo the request.
      failures,
    });
  },
});
