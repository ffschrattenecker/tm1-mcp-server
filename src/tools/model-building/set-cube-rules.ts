import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { IDEMPOTENT_DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerSetCubeRules = defineTool({
  name: "tm1_set_cube_rules",
  description: [
    "Create or replace the rules for a TM1 cube.",
    "SKIPCHECK; belongs at the top and FEEDERS; before all feeder definitions — SKIPCHECK is what makes feeders take effect, so rules with feeders need it.",
    "Replaces existing rules completely — always provide the full rules text.",
    "The text is syntax-checked with tm1.CheckRules before it is written: TM1 itself stores broken rules without an error, and they then silently compute nothing. Any error aborts the call with VALIDATION_ERROR and the errors with their line numbers; nothing is written. preflight:false skips the check.",
    "After: tm1_get_cube_rules to read back, tm1_invalidate_callgraph_cache is called automatically (rule changes shift DB() / feeder edges).",
  ],
  annotations: IDEMPOTENT_DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
    rules: z
      .string()
      .describe(
        "Full rules text. Put SKIPCHECK; first and a FEEDERS; section after the rule statements — SKIPCHECK is a line in this text, there is no separate switch for it.",
      ),
    preflight: z
      .boolean()
      .default(true)
      .describe(
        "Syntax-check the rules before writing (default true). false writes the text as is, errors and all.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, rules, preflight, confirm }, tm1Client) => {
    // Replaces the cube's ENTIRE rule file; the previous text is not
    // recoverable through this API. Guards against accidental invocation —
    // not a security control.
    requireConfirm(confirm, cubeName, "cube");
    // The Rules PATCH stores syntactically broken text with a 200 (measured on
    // 11.8 and 12.5), and the broken statements then compute nothing — no
    // error anywhere. tm1.CheckRules finds what the PATCH lets through.
    if (preflight) {
      const errors = await tm1Client.cubes.checkRule(cubeName, rules);
      if (errors.length > 0) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Rules for '${cubeName}' have ${errors.length} syntax error(s): ${errors
            .slice(0, 5)
            .map((e) => `line ${e.lineNumber ?? "?"}: ${e.message.trim()}`)
            .join("; ")}. Nothing was written.`,
          hint: "Fix the reported lines and retry. preflight:false writes the text anyway; TM1 stores it, but the broken statements compute nothing.",
          details: JSON.stringify({ stage: "preflight", errors }),
        });
      }
    }
    await withToolHint(
      tm1Client.cubes.updateRules(cubeName, rules),
      `Pre-flight syntax with tm1_check_cube_rule(cubeName='${cubeName}', rules=...) before set_cube_rules. Inspect details for the offending line.`,
    );
    const lineCount = rules.split("\n").length;
    // Rule changes shift call edges (DB(), feeders) — drop callgraph TTL early.
    const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();
    return actionResponse({
      success: true,
      cubeName,
      lineCount,
      callgraphEntriesCleared,
    });
  },
});
