import { describe, expect, it } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { CubeRules } from "../../src/types.js";
import { registerGetAllCubeRules } from "../../src/tools/model-building/get-all-cube-rules.js";

// Token-opt 2026-07-18: tm1_get_all_cube_rules default-caps full-rules
// responses at 50 cubes (server-side $top); summary mode still surveys the
// whole model by default, and onlyWithRules keeps its client-side filter.

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// Capture the raw zod shape + handler, then parse inputs through
// z.object(shape) so schema defaults apply exactly as the live SDK would.
function capture(client: TM1Client): { schema: ZodRawShape; handler: Handler } {
  let schema: ZodRawShape | undefined;
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _desc: string, s: ZodRawShape, h: Handler) => {
      schema = s;
      handler = h;
    },
  } as unknown as McpServer;
  registerGetAllCubeRules(server, client);
  if (!schema || !handler) throw new Error("tool was not registered");
  return { schema, handler };
}

interface BulkResult {
  count: number;
  returned: number;
  truncated: boolean;
  cubes: Array<Record<string, unknown>>;
}

async function run(
  client: TM1Client,
  input: Record<string, unknown>,
): Promise<BulkResult> {
  const { schema, handler } = capture(client);
  const args = z.object(schema).parse(input);
  const res = await handler(args, {});
  return JSON.parse(res.content[0].text) as BulkResult;
}

// Bulk-rules stub mirroring the CubeService.getAllRules overload: plain array
// without a cap, { items, total } when the tool pushes $top server-side.
function bulkRulesClient(rows: CubeRules[]): TM1Client {
  return contractCheckedClient({
    cubes: {
      getAllRules: async (_includeControl?: boolean, top?: number) =>
        top === undefined
          ? rows
          : { items: rows.slice(0, top), total: rows.length },
    },
  } as unknown as TM1Client);
}

function cube(name: string, rulesText: string): CubeRules {
  return {
    cubeName: name,
    rulesText,
    skipCheck: rulesText.toUpperCase().includes("SKIPCHECK"),
  };
}

describe("tm1_get_all_cube_rules default cap", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    cube(
      `Cube.${String(i).padStart(2, "0")}`,
      i % 2 === 0 ? "SKIPCHECK;\n['A'] = N: 1;" : "",
    ),
  );
  const client = bulkRulesClient(rows);

  it.each([
    {
      label: "caps full-rules responses at 50 by default and flags truncation",
      input: {},
      returned: 50,
      truncated: true,
      count: 60,
    },
    {
      label: "an explicit limit overrides the default cap",
      input: { limit: 10 },
      returned: 10,
      truncated: true,
      count: 60,
    },
    {
      label: "limit=0 returns everything uncapped",
      input: { limit: 0 },
      returned: 60,
      truncated: false,
      count: 60,
    },
    {
      label:
        "summary mode surveys all cubes by default (no cap) and drops rulesText",
      input: { summary: true },
      returned: 60,
      truncated: false,
      count: 60,
    },
    {
      label: "an explicit limit also caps summary mode",
      input: { summary: true, limit: 5 },
      returned: 5,
      truncated: true,
      count: 60,
    },
    {
      // 30 of the 60 cubes carry rules — under the default cap of 50, so no
      // truncation; count must be the post-filter total, like before the cap.
      label:
        "onlyWithRules filters client-side; count reflects the post-filter set",
      input: { onlyWithRules: true },
      returned: 30,
      truncated: false,
      count: 30,
    },
    {
      label:
        "onlyWithRules with a smaller limit truncates deterministically by name",
      input: { onlyWithRules: true, limit: 3 },
      returned: 3,
      truncated: true,
      count: 30,
    },
  ])("$label", async ({ input, returned, truncated, count }) => {
    const parsed = await run(client, input);
    expect(parsed.returned).toBe(returned);
    expect(parsed.truncated).toBe(truncated);
    expect(parsed.count).toBe(count);
  });

  it("returns the full cube list for the default cap and the summary shape", async () => {
    const full = await run(client, {});
    expect(full.cubes).toHaveLength(50);
    const summary = await run(client, { summary: true });
    expect(summary.cubes[0].rulesText).toBeUndefined();
    expect(summary.cubes[0].lineCount).toBeDefined();
  });

  it("onlyWithRules keeps only cubes with rule text, truncated by name order", async () => {
    const filtered = await run(client, { onlyWithRules: true });
    expect(
      filtered.cubes.every((c) => String(c.rulesText).trim().length > 0),
    ).toBe(true);
    const capped = await run(client, { onlyWithRules: true, limit: 3 });
    expect(capped.cubes.map((c) => c.cubeName)).toEqual([
      "Cube.00",
      "Cube.02",
      "Cube.04",
    ]);
  });
});

describe("tm1_get_all_cube_rules summary", () => {
  it("lists only live DB() calls in referencedCubes", async () => {
    const client = bulkRulesClient([
      cube(
        "Sales",
        "SKIPCHECK;\n# x = DB('Hidden', 'a')\n['A'] = N: DB('Rates', 'EUR');",
      ),
    ]);
    const parsed = await run(client, { summary: true });
    expect(parsed.cubes[0].referencedCubes).toEqual(["Rates"]);
  });
});
