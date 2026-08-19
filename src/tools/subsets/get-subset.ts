import { z } from "zod";
import { READ_ONLY } from "../annotations.js";
import { SubsetSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerGetSubset = defineTool({
  name: "tm1_get_subset",
  description:
    "Get a single TM1 subset with its MDX expression (if any) and resolved element list. Use isPrivate=true for private subsets.",
  annotations: READ_ONLY,
  output: SubsetSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    hierarchyName: z.string().describe("Hierarchy name"),
    subsetName: z.string().describe("Subset name"),
    isPrivate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Look up the subset in PrivateSubsets instead of public Subsets",
      ),
  },
  handler: async (
    { dimensionName, hierarchyName, subsetName, isPrivate },
    tm1Client,
  ) => {
    const subset = await tm1Client.subsets.get(
      dimensionName,
      hierarchyName,
      subsetName,
      isPrivate ?? false,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(subset) }],
    };
  },
});
