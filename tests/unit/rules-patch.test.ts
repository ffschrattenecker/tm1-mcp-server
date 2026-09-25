import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { applyRulesPatch } from "../../src/lib/rules-patch.js";
import { registerSetCubeRules } from "../../src/tools/model-building/set-cube-rules.js";
import { registerCheckCubeRule } from "../../src/tools/model-building/check-cube-rule.js";
import { TM1Error } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";

const STORED = [
  "SKIPCHECK;",
  "['Var'] = ['Fcst'] - ['Plan'];",
  "['Pct'] = ['Var'] \\ ['Plan'];",
  "FEEDERS;",
  "['Plan'] => ['Var'];",
  "['Plan'] => ['Pct'];",
].join("\r\n");

describe("applyRulesPatch", () => {
  it("applies edits in order and keeps the stored CRLF line endings", () => {
    const out = applyRulesPatch(STORED, [
      // Quoted with LF, as a get_cube_rules lineRange slice arrives.
      {
        find: "['Var'] = ['Fcst'] - ['Plan'];\n['Pct']",
        replace: "['Var'] = ['Act'] - ['Plan'];\n['Pct']",
      },
      // Sees the text the first edit produced.
      { find: "['Act']", replace: "['Actual']" },
    ]);
    expect(out).toBe(STORED.replace("['Fcst']", "['Actual']"));
    expect(out.split("\r\n")).toHaveLength(6);
  });

  it("rejects a find that does not occur, before anything is written", () => {
    const err = (() => {
      try {
        applyRulesPatch(STORED, [{ find: "['Nope']", replace: "" }]);
      } catch (e) {
        return e as TM1Error;
      }
    })();
    expect(err).toBeInstanceOf(TM1Error);
    expect(err!.message).toContain("matches 0 times");
    expect(JSON.parse(err!.details!)).toEqual({ edit: 0, matches: 0 });
  });

  it("rejects an ambiguous find and names the lines it matched", () => {
    expect(() =>
      applyRulesPatch(STORED, [{ find: "['Plan'] =>", replace: "x" }]),
    ).toThrow(/matches 2 times at lines 5, 6/);
  });

  it("rejects an empty find", () => {
    expect(() => applyRulesPatch(STORED, [{ find: "", replace: "x" }])).toThrow(
      /find is empty/,
    );
  });
});

describe("tm1_set_cube_rules sources", () => {
  const written: Array<[string, string]> = [];
  const checked: string[] = [];
  let checkErrors: Array<{ lineNumber?: number; message: string }> = [];
  const client = {
    cubes: {
      checkRule: async (_c: string, t: string) => {
        checked.push(t);
        return checkErrors;
      },
      getRules: async () => ({
        cubeName: "Sales",
        rulesText: STORED,
        skipCheck: true,
      }),
      updateRules: async (c: string, t: string) => {
        written.push([c, t]);
      },
    },
  } as unknown as TM1Client;

  function call(
    args: Record<string, unknown>,
    register: typeof registerSetCubeRules = registerSetCubeRules,
  ) {
    let h: ((a: unknown) => Promise<unknown>) | null = null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    register(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      client,
    );
    return h!(parser!.parse(args)) as Promise<{
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
      isError?: boolean;
    }>;
  }

  afterEach(() => {
    written.length = 0;
    checked.length = 0;
    checkErrors = [];
    delete process.env.TM1_LOCAL_FILE_ROOT;
  });

  it("patch mode reads the current text and writes the patched whole", async () => {
    const res = await call({
      cubeName: "Sales",
      confirm: "Sales",
      edits: [{ find: "['Fcst']", replace: "['Actual']" }],
    });
    expect(written).toEqual([
      ["Sales", STORED.replace("['Fcst']", "['Actual']")],
    ]);
    expect(res.structuredContent).toMatchObject({
      mode: "patch",
      editsApplied: 1,
    });
  });

  it("a failing edit writes nothing", async () => {
    await expect(
      call({
        cubeName: "Sales",
        confirm: "Sales",
        edits: [
          { find: "['Fcst']", replace: "['Actual']" },
          { find: "['Missing']", replace: "" },
        ],
      }),
    ).rejects.toThrow(/edits\[1\]\.find matches 0 times/);
    expect(written).toEqual([]);
  });

  it("filePath mode reads the file under TM1_LOCAL_FILE_ROOT", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rules-"));
    const file = path.join(root, "sales.rules");
    writeFileSync(file, "SKIPCHECK;\n['A'] = 1;\n");
    process.env.TM1_LOCAL_FILE_ROOT = root;
    const res = await call({
      cubeName: "Sales",
      confirm: "Sales",
      filePath: file,
    });
    expect(written).toEqual([["Sales", "SKIPCHECK;\n['A'] = 1;\n"]]);
    expect(res.structuredContent.mode).toBe("file");
  });

  it("requires exactly one source", async () => {
    await expect(call({ cubeName: "Sales", confirm: "Sales" })).rejects.toThrow(
      /exactly one of rules, edits or filePath \(got 0\)/,
    );
    await expect(
      call({
        cubeName: "Sales",
        confirm: "Sales",
        rules: "SKIPCHECK;",
        edits: [{ find: "a", replace: "b" }],
      }),
    ).rejects.toThrow(/got 2/);
  });

  it("still requires confirm", async () => {
    await expect(
      call({ cubeName: "Sales", confirm: "Salez", rules: "SKIPCHECK;" }),
    ).rejects.toThrow(/confirm mismatch/);
  });

  it("preflight checks the full patched text and a failure writes nothing", async () => {
    checkErrors = [{ lineNumber: 2, message: "Syntax error" }];
    const res = await call({
      cubeName: "Sales",
      confirm: "Sales",
      edits: [{ find: "['Fcst'] - ['Plan'];", replace: "['Fcst'] - ;" }],
    });
    expect(checked).toEqual([
      STORED.replace("['Fcst'] - ['Plan'];", "['Fcst'] - ;"),
    ]);
    expect(written).toEqual([]);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      stage: "preflight",
      check: "syntax",
      errors: [{ lineNumber: 2 }],
    });
  });

  it("preflight:false writes without checking", async () => {
    checkErrors = [{ lineNumber: 1, message: "Syntax error" }];
    await call({
      cubeName: "Sales",
      confirm: "Sales",
      rules: "SKIPCHECK;",
      preflight: false,
    });
    expect(checked).toEqual([]);
    expect(written).toEqual([["Sales", "SKIPCHECK;"]]);
  });

  it("tm1_check_cube_rule validates an edits patch as it would be installed", async () => {
    const res = await call(
      {
        cubeName: "Sales",
        edits: [{ find: "['Fcst']", replace: "['Actual']" }],
      },
      registerCheckCubeRule,
    );
    expect(checked).toEqual([STORED.replace("['Fcst']", "['Actual']")]);
    expect(written).toEqual([]);
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: true,
      lineCount: 6,
    });
  });
});
