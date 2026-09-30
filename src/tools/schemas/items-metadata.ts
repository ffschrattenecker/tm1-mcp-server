// Metadata-domain result schemas: cube rules, cube stats and default members.
import { z } from "zod";

export const CubeRulesSchema = z.object({
  cubeName: z.string(),
  skipCheck: z.boolean(),
  // Full mode (default): rulesText carries the verbatim TM1 rule body.
  // Summary mode (tm1_get_all_cube_rules summary=true): rulesText is replaced
  // by aggregate metrics so analysis agents can survey rule landscapes
  // without paying full token cost.
  rulesText: z.string().optional(),
  lineCount: z.number().int().optional(),
  ruleCount: z.number().int().optional(),
  feederCount: z.number().int().optional(),
  commentLineCount: z.number().int().optional(),
  referencedCubes: z.array(z.string()).optional(),
  // tm1_get_cube_rules outline=true: section markers instead of the text.
  outline: z
    .array(z.object({ line: z.number().int(), text: z.string() }))
    .optional(),
  outlineTruncated: z.boolean().optional(),
  // tm1_get_cube_rules lineRange: the [from, to] actually returned (clamped).
  lineRange: z.array(z.number().int()).optional(),
});

// ── tm1_get_cube_stats result schemas ────────────────────────────────────────
// Stats elements differ between TM1 v11 and v12. We expose well-known names
// as typed fields (best-effort match) and the entire raw element-name → value
// map under `raw` so callers can read whatever the server actually returned
// — no version drift breaks the tool, only renames new well-known fields.
export const CubeStatsItemSchema = z
  .object({
    cubeName: z.string(),
    // Cell counts
    populatedNumeric: z.number().optional(),
    populatedString: z.number().optional(),
    storedCalculated: z.number().optional(),
    storedViews: z.number().optional(),
    fedCells: z.number().optional(),
    // Memory (bytes)
    memoryViews: z.number().optional(),
    memoryInput: z.number().optional(),
    memoryFeeders: z.number().optional(),
    memoryCalculations: z.number().optional(),
    memoryTotal: z.number().optional(),
    // Performance
    avgCalculationSteps: z.number().optional(),
    cacheMissRate: z.number().optional(),
    // Derived
    feederEfficiency: z.number().optional(),
    // Always present: full element-name → value map (carries everything,
    // including v12-only or new-build metrics that aren't in KNOWN_METRICS).
    raw: z.record(z.string(), z.union([z.number(), z.null()])),
    error: z.string().optional(),
  })
  .passthrough();

// Set only when EVERY requested cube failed the same server- or account-wide
// way: `absent` = no }Stats* control cubes here (TM1 v12 ships none),
// `denied` = they exist but this account may not read them.
export const StatsUnavailableSchema = z.object({
  reason: z.enum(["absent", "denied"]),
  message: z.string(),
});

export const CubeStatsResultSchema = z
  .object({
    count: z.number().int(),
    items: z.array(CubeStatsItemSchema),
    statsUnavailable: StatsUnavailableSchema.optional(),
  })
  .passthrough();

// ── Phase 2i: hierarchy navigation, server snapshots, diagnostics ────────────

export const DefaultMemberResolutionSchema = z.object({
  dimension: z.string(),
  hierarchy: z.string(),
  resolved: z.object({ name: z.string(), level: z.number().int() }),
  source: z.enum(["defined", "single_root", "first_root", "index_1"]),
  confidence: z.enum(["high", "medium", "low"]),
  alternatives: z
    .object({
      roots: z.array(z.object({ name: z.string(), level: z.number().int() })),
      indexOne: z.string().optional(),
    })
    .optional(),
  warning: z.string().optional(),
});

export const DefaultMemberErrorSchema = z.object({
  dimension: z.string(),
  hierarchy: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
});

export const DefaultMembersBulkResultSchema = z.object({
  results: z.array(
    z.union([DefaultMemberResolutionSchema, DefaultMemberErrorSchema]),
  ),
});
