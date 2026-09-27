// tm1_set_cube_rules syntax-checks before it writes. The Rules PATCH stores
// broken text with a 200 on 11.8 and 12.5, and the broken statements then
// compute nothing, so without the check a typo reaches the cube silently.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerSetCubeRules } from "../../src/tools/model-building/set-cube-rules.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function handlerFor(client: TM1Client): ToolHandler {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: ToolHandler) => {
      parser = z.object(schema);
      captured = h;
    },
  } as unknown as Parameters<typeof registerSetCubeRules>[0];
  registerSetCubeRules(server, client);
  return (args) => captured!(parser!.parse(args));
}

function makeClient(errors: Array<{ message: string; lineNumber?: number }>) {
  const checkRule = vi.fn(async () => errors);
  const updateRules = vi.fn(async () => undefined);
  return {
    checkRule,
    updateRules,
    client: { cubes: { checkRule, updateRules } } as unknown as TM1Client,
  };
}

const BROKEN = "SKIPCHECK;\n['m1'] = N: NOPE(1, ;\n";

describe("tm1_set_cube_rules preflight", () => {
  it("refuses rules with syntax errors and writes nothing", async () => {
    const { client, updateRules } = makeClient([
      { message: "Syntax error on or before: NOPE(1, ;", lineNumber: 2 },
    ]);
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        rules: BROKEN,
        confirm: "Sales",
      }),
    ).rejects.toThrow(/line 2: Syntax error.*Nothing was written/);
    expect(updateRules).not.toHaveBeenCalled();
  });

  it("writes clean rules after checking them", async () => {
    const { client, checkRule, updateRules } = makeClient([]);
    await handlerFor(client)({
      cubeName: "Sales",
      rules: "SKIPCHECK;",
      confirm: "Sales",
    });
    expect(checkRule).toHaveBeenCalledWith("Sales", "SKIPCHECK;");
    expect(updateRules).toHaveBeenCalledWith("Sales", "SKIPCHECK;");
  });

  it("preflight:false skips the check and writes as is", async () => {
    const { client, checkRule, updateRules } = makeClient([
      { message: "boom", lineNumber: 1 },
    ]);
    await handlerFor(client)({
      cubeName: "Sales",
      rules: BROKEN,
      preflight: false,
      confirm: "Sales",
    });
    expect(checkRule).not.toHaveBeenCalled();
    expect(updateRules).toHaveBeenCalledWith("Sales", BROKEN);
  });

  it("checks confirm before spending the preflight request", async () => {
    const { client, checkRule } = makeClient([]);
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        rules: "SKIPCHECK;",
        confirm: "Other",
      }),
    ).rejects.toThrow();
    expect(checkRule).not.toHaveBeenCalled();
  });
});
