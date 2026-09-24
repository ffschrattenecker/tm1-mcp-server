import { z } from "zod";
import { CubeRulesSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import {
  outlineRules,
  sliceLines,
  splitLines,
} from "../../lib/rules-outline.js";

export const registerGetCubeRules = defineTool({
  name: "tm1_get_cube_rules",
  description: [
    "Get the current rules text for a TM1 cube. Returns empty string if no rules are defined.",
    "Large rule files: outline=true lists the section markers (SKIPCHECK, FEEDERS, comment headers) with line numbers and lineCount; then lineRange=[from, to] reads just that slice.",
  ],
  annotations: READ_ONLY,
  output: CubeRulesSchema,
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
    outline: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Return section markers with 1-based line numbers and lineCount instead of the text.",
      ),
    lineRange: z
      .array(z.number().int().positive())
      .length(2)
      .optional()
      .describe(
        "[from, to], 1-based inclusive: return only these lines, verbatim (clamped to the text).",
      ),
  },
  handler: async ({ cubeName, outline, lineRange }, tm1Client) => {
    if (outline && lineRange !== undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "outline and lineRange are mutually exclusive — pass one.",
      });
    }
    const [from, to] = lineRange ?? [];
    if (from !== undefined && to !== undefined && from > to) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `lineRange [${from}, ${to}] is inverted — from must be ≤ to.`,
      });
    }
    const rules = await tm1Client.cubes.getRules(cubeName);
    const text = rules.rulesText ?? "";
    let output: Record<string, unknown> = { ...rules };
    if (outline) {
      const { outline: entries, truncated } = outlineRules(text);
      const { rulesText: _omit, ...rest } = rules;
      output = {
        ...rest,
        lineCount: text === "" ? 0 : splitLines(text).length,
        outline: entries,
        ...(truncated ? { outlineTruncated: true } : {}),
      };
    } else if (from !== undefined && to !== undefined) {
      const slice = sliceLines(text, from, to);
      output = {
        ...rules,
        rulesText: slice.text,
        lineCount: splitLines(text).length,
        lineRange: [slice.from, slice.to],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
    };
  },
});
