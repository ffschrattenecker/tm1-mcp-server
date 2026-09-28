import { describe, expect, it } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerDiffCubeRules } from "../../src/tools/analysis/diff-cube-rules.js";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { peerRunner } from "../helpers/peer-tool.js";

function client(
  cubes: Record<string, { rules: string; dims: string[] }>,
): TM1Client {
  return contractCheckedClient({
    cubes: {
      getRules: async (name: string) => ({
        cubeName: name,
        rulesText: cubes[name].rules,
        skipCheck: /^\s*SKIPCHECK\s*;/im.test(cubes[name].rules),
      }),
      getDimensionNames: async (name: string) => cubes[name].dims,
    },
  } as unknown as TM1Client);
}

interface Result {
  identical: boolean;
  connectionA: string;
  connectionB: string;
  cubeB: string;
  dimensions: { identical: boolean };
  skipCheck: { a: boolean; b: boolean };
  feeders: { a: boolean; b: boolean };
  rules: {
    identical: boolean;
    hunks: Array<{ lines: Array<{ type: string; text: string }> }>;
    hunksOmitted?: number;
  };
}

const RULES =
  "SKIPCHECK;\n['Total'] = N: ['A'] + ['B'];\nFEEDERS;\n['A'] => ['Total'];";

describe("tm1_diff_cube_rules", () => {
  const run = peerRunner(registerDiffCubeRules, {
    dev: client({
      Sales: {
        rules: RULES.replace("['B']", "['C']"),
        dims: ["Version", "Measure"],
      },
    }),
    prod: client({
      Sales: { rules: RULES, dims: ["version", "Measure"] },
      Copy: { rules: RULES, dims: ["Version", "Measure"] },
    }),
  });

  it("finds a one-token change between connections", async () => {
    const r = await run<Result>({
      cube: "Sales",
      connection: "prod",
      connectionB: "dev",
    });
    expect(r.identical).toBe(false);
    // Dimension names compare case-insensitively, as TM1 does.
    expect(r.dimensions.identical).toBe(true);
    expect(r.skipCheck).toEqual({ a: true, b: true });
    expect(r.feeders).toEqual({ a: true, b: true });
    expect(r.rules.hunks).toHaveLength(1);
    expect(r.rules.hunks[0].lines.filter((l) => l.type !== " ")).toEqual([
      { type: "-", text: "['Total'] = N: ['A'] + ['B'];" },
      { type: "+", text: "['Total'] = N: ['A'] + ['C'];" },
    ]);
  });

  it("compares two cubes on one connection via cubeB", async () => {
    const r = await run<Result>({
      cube: "Sales",
      cubeB: "Copy",
      connection: "prod",
    });
    expect(r).toMatchObject({
      identical: true,
      cubeB: "Copy",
      connectionA: "prod",
      connectionB: "prod",
    });
  });

  it("caps the returned hunks", async () => {
    const many = (x: string) =>
      Array.from({ length: 40 }, (_, i) =>
        i % 10 === 0 ? `['L${i}'] = ${x};` : `# line ${i}`,
      ).join("\n");
    const runMany = peerRunner(registerDiffCubeRules, {
      dev: client({ C: { rules: many("1"), dims: ["D"] } }),
      prod: client({ C: { rules: many("2"), dims: ["D"] } }),
    });
    const r = await runMany<Result>({
      cube: "C",
      connection: "dev",
      connectionB: "prod",
      contextLines: 0,
      maxHunks: 1,
    });
    expect(r.rules.hunks).toHaveLength(1);
    expect(r.rules.hunksOmitted).toBe(3);
  });
});
