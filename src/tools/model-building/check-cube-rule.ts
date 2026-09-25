import { z } from "zod";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { RULES_SOURCE_SCHEMA, resolveRulesText } from "./rules-source.js";

export const registerCheckCubeRule = defineTool({
  name: "tm1_check_cube_rule",
  description: [
    "Validate the syntax of a TM1 cube rule WITHOUT applying it.",
    "Returns 'valid' or a list of syntax errors with line numbers.",
    "Takes the same sources as tm1_set_cube_rules — rules, edits or filePath — and checks the full resulting text, so an edits patch is validated exactly as it would be installed. tm1_set_cube_rules runs this check itself before writing.",
  ],
  annotations: READ_ONLY,
  output: {
    ok: z.boolean(),
    cube: z.string(),
    lineCount: z.number().int(),
    errorCount: z.number().int(),
    errors: z.array(
      z.object({
        lineNumber: z.number().int().optional(),
        message: z.string(),
      }),
    ),
  },
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
    ...RULES_SOURCE_SCHEMA,
  },
  handler: async ({ cubeName, rules, edits, filePath }, tm1Client) => {
    const { text } = await resolveRulesText(tm1Client, cubeName, {
      rules,
      edits,
      filePath,
    });
    const errors = await tm1Client.cubes.checkRule(cubeName, text);
    const ok = errors.length === 0;
    const payload = {
      ok,
      cube: cubeName,
      lineCount: text.split("\n").length,
      errorCount: errors.length,
      errors: errors.map((e) => ({
        lineNumber: e.lineNumber,
        message: e.message,
      })),
    };
    return {
      isError: !ok || undefined,
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
