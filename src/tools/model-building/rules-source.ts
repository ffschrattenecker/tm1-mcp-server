// The three ways a caller hands over rule text — full `rules`, an `edits`
// patch against the stored text, or a host `filePath` — resolved to the one
// full text TM1 will see. Shared by tm1_set_cube_rules (what gets written)
// and tm1_check_cube_rule (what gets validated), so a patch can be checked
// exactly as it will be installed without the caller rebuilding the file.
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { applyRulesPatch, type RulesEdit } from "../../lib/rules-patch.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";

export const RULES_SOURCE_SCHEMA = {
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
};

export interface RulesSource {
  rules?: string | undefined;
  edits?: RulesEdit[] | undefined;
  filePath?: string | undefined;
}

export async function resolveRulesText(
  tm1Client: TM1Client,
  cubeName: string,
  { rules, edits, filePath }: RulesSource,
): Promise<{ text: string; mode: "full" | "patch" | "file" }> {
  const sources = [rules, edits, filePath].filter((s) => s !== undefined);
  if (sources.length !== 1) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Pass exactly one of rules, edits or filePath (got ${sources.length}).`,
    });
  }
  if (edits !== undefined) {
    const current = await tm1Client.cubes.getRules(cubeName);
    return {
      text: applyRulesPatch(current.rulesText ?? "", edits),
      mode: "patch",
    };
  }
  if (filePath !== undefined) {
    return {
      text: await fs.readFile(resolveLocalPath(filePath), "utf8"),
      mode: "file",
    };
  }
  return { text: rules!, mode: "full" };
}
