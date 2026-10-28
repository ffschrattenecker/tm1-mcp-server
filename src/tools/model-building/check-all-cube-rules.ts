// Re-check the rules TM1 already stores. TM1 lets an element or cube a stored
// rule names be deleted and keeps the text (11.8.03500); only re-checking the
// stored text shows it.
import { z } from "zod";
import type { DbCheckLookups } from "../../lib/rules-db-check.js";
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import type { TM1Client } from "../../tm1-client.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { checkRulesText } from "./rules-source.js";
import { jsonResult } from "../format.js";

// Cubes checked at once: each check is one CheckRules POST plus the DB()
// lookups not cached yet.
const CONCURRENCY = 4;

// Promises are cached, so concurrent checks share one request.
function memo<A extends string[], R>(
  fn: (...args: A) => Promise<R>,
  cache = new Map<string, Promise<R>>(),
): (...args: A) => Promise<R> {
  return (...args) => {
    const k = args.join("\u0000").toLowerCase();
    let p = cache.get(k);
    if (!p) {
      p = fn(...args);
      cache.set(k, p);
    }
    return p;
  };
}

// The DB() lookups for one sweep, cached: many cubes DB() into the same few
// cubes, and a whole-model check would otherwise ask for them once per cube.
function cachedLookups(
  tm1Client: TM1Client,
  knownDims: Map<string, string[]>,
): DbCheckLookups {
  const dimsCache = new Map<string, Promise<string[]>>();
  for (const [cube, names] of knownDims)
    dimsCache.set(cube.toLowerCase(), Promise.resolve(names));
  return {
    cubes: {
      getDimensionNames: memo(
        (cube) => tm1Client.cubes.getDimensionNames(cube),
        dimsCache,
      ),
    },
    elements: {
      exists: memo((dim, hier, el) => tm1Client.elements.exists(dim, hier, el)),
    },
  };
}

export const registerCheckAllCubeRules = defineTool({
  name: "tm1_check_all_cube_rules",
  description: [
    "Run tm1_check_cube_rule's checks on the stored rules of every cube; returns only the cubes with errors.",
    "Run it after deleting or renaming elements, dimensions or cubes: TM1 keeps rule text that names them, and those rules then compute nothing without an error.",
  ],
  annotations: READ_ONLY,
  output: {
    cubesChecked: z.number().int().describe("Cubes with non-empty rules"),
    cubesWithErrors: z.number().int(),
    cubes: z.array(
      z.object({
        cube: z.string(),
        errorCount: z.number().int(),
        errors: z.array(
          z.object({
            lineNumber: z.number().int().optional(),
            message: z.string(),
          }),
        ),
      }),
    ),
  },
  input: {
    includeControl: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Include TM1 control cubes whose names start with '}' (default: false)",
      ),
  },
  handler: async ({ includeControl }, tm1Client) => {
    const all = await tm1Client.cubes.getAllRules({
      includeControl,
      withDimensions: true,
    });
    const withRules = all
      .filter((c) => c.rulesText.trim().length > 0)
      .sort((a, b) => a.cubeName.localeCompare(b.cubeName));
    const lookups = cachedLookups(
      tm1Client,
      new Map(
        all.flatMap((c) =>
          c.dimensions ? [[c.cubeName, c.dimensions] as const] : [],
        ),
      ),
    );
    const settled = await mapSettledWithConcurrency(
      withRules,
      CONCURRENCY,
      (c) => checkRulesText(tm1Client, c.cubeName, c.rulesText, lookups),
    );
    const cubes = withRules.flatMap((c, i) => {
      const r = settled[i]!;
      // A check that could not run (auth, transport, denial) must surface,
      // not read as a clean cube.
      if (r.status === "rejected") throw r.reason;
      if (r.value.length === 0) return [];
      return [
        {
          cube: c.cubeName,
          errorCount: r.value.length,
          errors: r.value.map((e) => ({
            lineNumber: e.lineNumber,
            message: e.message,
          })),
        },
      ];
    });
    const payload = {
      cubesChecked: withRules.length,
      cubesWithErrors: cubes.length,
      cubes,
    };
    return jsonResult(payload);
  },
});
