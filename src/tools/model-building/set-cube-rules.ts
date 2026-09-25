import { z } from "zod";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";
import { TM1ErrorCode } from "../../types.js";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { IDEMPOTENT_DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { RULES_SOURCE_SCHEMA, resolveRulesText } from "./rules-source.js";

export const registerSetCubeRules = defineTool({
  name: "tm1_set_cube_rules",
  description: [
    "Create or replace the rules for a TM1 cube.",
    "SKIPCHECK; belongs at the top and FEEDERS; before all feeder definitions — SKIPCHECK is what makes feeders take effect, so rules with feeders need it.",
    "Pass exactly one source: rules (the full text — replaces everything), edits (find/replace patch against the current text; each find must match exactly once, else nothing is written), or filePath (full text from a host file under TM1_LOCAL_FILE_ROOT).",
    "The full resulting text is syntax-checked before anything is written (preflight). The stored text is read back after writing (verified.textMatches), so no separate tm1_get_cube_rules is needed; the callgraph cache is dropped automatically.",
  ],
  annotations: IDEMPOTENT_DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
    ...RULES_SOURCE_SCHEMA,
    ...CONFIRM_SCHEMA,
    preflight: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Before writing, syntax-check the full text as it will be installed (tm1.CheckRules) and abort on any error. Default true.",
      ),
  },
  handler: async (
    { cubeName, rules, edits, filePath, confirm, preflight },
    tm1Client,
  ) => {
    // Replaces the cube's ENTIRE rule file; the previous text is not
    // recoverable through this API. Guards against accidental invocation —
    // not a security control.
    requireConfirm(confirm, cubeName, "cube");
    const { text, mode } = await resolveRulesText(tm1Client, cubeName, {
      rules,
      edits,
      filePath,
    });
    // TM1 11.8 stores rule text with syntax errors without complaint (verified
    // live: `['X'] = N: ['A'] * 2 +;` saved and read back). The cube then
    // computes nothing for those cells until someone notices. CheckRules is
    // the only gate, so it runs here rather than being left to the caller.
    if (preflight) {
      const errors = await tm1Client.cubes.checkRule(cubeName, text);
      if (errors.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                stage: "preflight",
                check: "syntax",
                cubeName,
                code: TM1ErrorCode.VALIDATION_ERROR,
                message: `Preflight rule check failed: ${errors.length} error(s). Nothing was written.`,
                hint: "Fix the lines in errors[] (lineNumber is in the full resulting text, after edits are applied). preflight:false skips the check; TM1 would store the broken text.",
                errors,
              }),
            },
          ],
          isError: true as const,
        };
      }
    }
    await withToolHint(
      tm1Client.cubes.updateRules(cubeName, text),
      `Inspect details for the offending line.`,
    );
    // Read back what TM1 stored, compared with line endings normalized. The
    // write has landed by now, so a failed read-back is reported, not thrown.
    const norm = (x: string) => x.replace(/\r\n/g, "\n").trimEnd();
    let verified: { textMatches: boolean } | { readBackError: string };
    try {
      const stored = (await tm1Client.cubes.getRules(cubeName)).rulesText;
      verified = { textMatches: norm(stored) === norm(text) };
    } catch (e) {
      verified = { readBackError: (e as Error).message };
    }
    const lineCount = text.split("\n").length;
    // Rule changes shift call edges (DB(), feeders) — drop callgraph TTL early.
    const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();
    return actionResponse({
      success: true,
      cubeName,
      mode,
      lineCount,
      ...(edits !== undefined ? { editsApplied: edits.length } : {}),
      callgraphEntriesCleared,
      verified,
    });
  },
});
