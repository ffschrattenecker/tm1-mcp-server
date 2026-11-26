// Toolset filtering for TM1_TOOLSETS to cut tools/list context cost.
export const TOOLSET_NAMES = [
  "metadata",
  "celldata",
  "ti-development",
  "dimension-management",
  "model-building",
  "scheduling",
  "operations",
  "fileops",
  "rest",
  "analysis",
  "sandboxes",
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

const TOOLSET_SET: ReadonlySet<string> = new Set(TOOLSET_NAMES);

const TOOLSET_ALIASES: Readonly<Record<string, ToolsetName>> = {
  ti: "ti-development",
  dimensions: "dimension-management",
  rules: "model-building",
  chores: "scheduling",
  ops: "operations",
  files: "fileops",
};

export const TOOLSET_PRESETS: Readonly<Record<string, readonly ToolsetName[]>> =
  {
    all: TOOLSET_NAMES,
    core: ["rest", "metadata", "celldata", "operations"],
    dev: [
      "rest",
      "metadata",
      "celldata",
      "operations",
      "ti-development",
      "model-building",
      "dimension-management",
      "scheduling",
    ],
    audit: ["rest", "metadata", "operations", "analysis"],
  };

/**
 * Parse `TM1_TOOLSETS` (comma-separated presets, category names, or aliases).
 * Returns `undefined` when unset/empty or when `"all"` is requested.
 */
export function parseToolsets(
  raw: string | undefined,
): ReadonlySet<ToolsetName> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const tokens = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;

  const selected = new Set<ToolsetName>();
  for (const token of tokens) {
    if (token === "all") return undefined;
    const preset = TOOLSET_PRESETS[token];
    if (preset) {
      for (const name of preset) selected.add(name);
      continue;
    }
    const aliased = TOOLSET_ALIASES[token] ?? token;
    if (TOOLSET_SET.has(aliased)) {
      selected.add(aliased as ToolsetName);
      continue;
    }
    throw new Error(
      `Invalid TM1_TOOLSETS entry: "${token}". Expected presets (${Object.keys(TOOLSET_PRESETS).join(", ")}) or toolsets (${TOOLSET_NAMES.join(", ")}).`,
    );
  }
  return selected;
}

/** Deterministic cache key for a parsed toolsets filter. */
export function toolsetsCacheKey(
  toolsets: ReadonlySet<ToolsetName> | undefined,
): string {
  if (!toolsets) return "all";
  return [...toolsets].sort().join(",");
}
