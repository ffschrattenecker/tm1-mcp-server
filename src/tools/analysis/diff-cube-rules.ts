import { z } from "zod";
import { tabCodeDiff } from "../../lib/line-diff.js";
import { tm1NameEquals } from "../../lib/tm1-name.js";
import { DiffCubeRulesResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

const FEEDERS = /^\s*FEEDERS\s*;/im;

export const registerDiffCubeRules = defineTool({
  name: "tm1_diff_cube_rules",
  description: [
    "Diff a cube's rules across connections (connectionB) or against cubeB, as unified hunks; also compares the dimension lists and SKIPCHECK/FEEDERS presence.",
  ],
  annotations: READ_ONLY,
  peer: true,
  output: DiffCubeRulesResultSchema,
  input: {
    cube: z.string().describe("Cube name (case-sensitive)."),
    cubeB: z
      .string()
      .optional()
      .describe(
        "Cube to compare against, read from connectionB. Default: the same cube.",
      ),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe("Lines of context around each hunk (default 3, max 10)."),
    maxHunks: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(50)
      .describe("Most hunks to return (default 50)."),
  },
  handler: async (
    { cube, cubeB: cubeBArg, contextLines, maxHunks },
    { a, b },
  ) => {
    const cubeB = cubeBArg ?? cube;
    const [rulesA, rulesB, dimsA, dimsB] = await Promise.all([
      a.client.cubes.getRules(cube),
      b.client.cubes.getRules(cubeB),
      a.client.cubes.getDimensionNames(cube),
      b.client.cubes.getDimensionNames(cubeB),
    ]);

    const diff = tabCodeDiff(rulesA.rulesText, rulesB.rulesText, contextLines);
    const hunksOmitted = Math.max(0, diff.hunks.length - maxHunks);
    const dimensionsIdentical =
      dimsA.length === dimsB.length &&
      dimsA.every((d, i) => tm1NameEquals(d, dimsB[i]!));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              cubeA: cube,
              cubeB,
              connectionA: a.name,
              connectionB: b.name,
              identical: diff.identical && dimensionsIdentical,
              dimensions: {
                identical: dimensionsIdentical,
                a: dimsA,
                b: dimsB,
              },
              skipCheck: { a: rulesA.skipCheck, b: rulesB.skipCheck },
              feeders: {
                a: FEEDERS.test(rulesA.rulesText),
                b: FEEDERS.test(rulesB.rulesText),
              },
              rules: {
                ...diff,
                hunks: diff.hunks.slice(0, maxHunks),
                ...(hunksOmitted > 0 ? { hunksOmitted } : {}),
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
