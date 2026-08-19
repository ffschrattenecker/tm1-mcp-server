import { z } from "zod";
import { CubeRulesSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetCubeRules = defineTool({
  name: "tm1_get_cube_rules",
  description:
    "Get the current rules text for a TM1 cube. Returns empty string if no rules are defined.",
  annotations: READ_ONLY,
  output: CubeRulesSchema,
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
  },
  handler: async ({ cubeName }, tm1Client) => {
    const rules = await tm1Client.cubes.getRules(cubeName);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rules) }],
    };
  },
});
