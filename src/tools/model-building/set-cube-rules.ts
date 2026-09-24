import { promises as fs } from "node:fs";
import { z } from "zod";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";
import { applyRulesPatch } from "../../lib/rules-patch.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { IDEMPOTENT_DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { resolveLocalPath } from "../local-file.js";

export const registerSetCubeRules = defineTool({
  name: "tm1_set_cube_rules",
  description: [
    "Create or replace the rules for a TM1 cube.",
    "SKIPCHECK; belongs at the top and FEEDERS; before all feeder definitions — SKIPCHECK is what makes feeders take effect, so rules with feeders need it.",
    "Pass exactly one source: rules (the full text — replaces everything), edits (find/replace patch against the current text; each find must match exactly once, else nothing is written), or filePath (full text from a host file under TM1_LOCAL_FILE_ROOT).",
    "Before: tm1_check_cube_rule to validate syntax. After: tm1_get_cube_rules to read back, tm1_invalidate_callgraph_cache is called automatically (rule changes shift DB() / feeder edges).",
  ],
  annotations: IDEMPOTENT_DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube name (case-sensitive)"),
    rules: z
      .string()
      .optional()
      .describe(
        "Full rules text. Put SKIPCHECK; first and a FEEDERS; section after the rule statements — SKIPCHECK is a line in this text, there is no separate switch for it.",
      ),
    edits: z
      .array(z.object({ find: z.string(), replace: z.string() }))
      .min(1)
      .optional()
      .describe(
        "Patch: applied in order to the current rules; each find must occur exactly once (quote a get_cube_rules lineRange slice verbatim). Line endings are normalized.",
      ),
    filePath: z
      .string()
      .optional()
      .describe(
        "Absolute host path of a full rules file. Disabled unless TM1_LOCAL_FILE_ROOT is set; must resolve within it.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, rules, edits, filePath, confirm }, tm1Client) => {
    // Replaces the cube's ENTIRE rule file; the previous text is not
    // recoverable through this API. Guards against accidental invocation —
    // not a security control.
    requireConfirm(confirm, cubeName, "cube");
    const sources = [rules, edits, filePath].filter((s) => s !== undefined);
    if (sources.length !== 1) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Pass exactly one of rules, edits or filePath (got ${sources.length}).`,
      });
    }
    let text: string;
    let mode: "full" | "patch" | "file";
    if (edits !== undefined) {
      const current = await tm1Client.cubes.getRules(cubeName);
      text = applyRulesPatch(current.rulesText ?? "", edits);
      mode = "patch";
    } else if (filePath !== undefined) {
      text = await fs.readFile(resolveLocalPath(filePath), "utf8");
      mode = "file";
    } else {
      text = rules!;
      mode = "full";
    }
    await withToolHint(
      tm1Client.cubes.updateRules(cubeName, text),
      `Pre-flight syntax with tm1_check_cube_rule(cubeName='${cubeName}', rules=...) before set_cube_rules. Inspect details for the offending line.`,
    );
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
    });
  },
});
