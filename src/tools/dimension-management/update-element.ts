import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { HIERARCHY_NAME_OPTIONAL, resolveHierarchy } from "../hierarchy.js";
const updateSchema = z.object({
  newName: z.string().optional().describe("New name for the element"),
  type: z
    .enum(["Numeric", "String", "Consolidated"])
    .optional()
    .describe(
      "New element type, changed in place. Numeric to Consolidated/String discards the element's leaf cell values; the result reports it as typeChange.",
    ),
  components: z
    .array(z.object({ name: z.string(), weight: z.number() }))
    .optional()
    .describe(
      "Replaces the element's complete child list: children not listed are removed from this parent (they stay in the dimension with their data). [] removes all children. To move an element between parents, update both parents.",
    ),
});

export const registerUpdateElement = defineTool({
  name: "tm1_update_element",
  description:
    "Update an existing element in a TM1 dimension hierarchy (name, type, or components). components replaces the whole child list, it does not append.",
  annotations: IDEMPOTENT_DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Name of the dimension"),
    ...HIERARCHY_NAME_OPTIONAL,
    elementName: z.string().describe("Current name of the element to update"),
    update: updateSchema.describe("Fields to update on the element"),
  },
  handler: async (
    { dimensionName, hierarchyName, elementName, update },
    tm1Client,
  ) => {
    const hierarchy = resolveHierarchy(dimensionName, hierarchyName);
    const { typeChange } = await tm1Client.elements.update(
      dimensionName,
      hierarchy,
      elementName,
      update,
    );
    return actionResponse({
      success: true,
      elementName,
      ...(typeChange && {
        typeChange,
        warning: `Type changed in place from ${typeChange.from} to ${typeChange.to}; any existing leaf cell values for this element were discarded.`,
      }),
    });
  },
});
