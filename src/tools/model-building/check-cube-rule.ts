import { z } from "zod";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCheckCubeRule = defineTool({
  name: "tm1_check_cube_rule",
  description: [
    "Validate the syntax of a TM1 cube rule WITHOUT applying it.",
    "Returns 'valid' or a list of syntax errors with line numbers.",
    "Use this as a pre-flight check before tm1_set_cube_rules to avoid committing broken rules.",
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
    rules: z
      .string()
      .describe(
        "Full rules text to validate (must include SKIPCHECK; / FEEDERS; structure if used)",
      ),
  },
  handler: async ({ cubeName, rules }, tm1Client) => {
    const errors = await tm1Client.cubes.checkRule(cubeName, rules);
    const ok = errors.length === 0;
    const payload = {
      ok,
      cube: cubeName,
      lineCount: rules.split("\n").length,
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
