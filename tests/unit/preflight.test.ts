import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { runPreflight } from "../../src/tools/ti-development/preflight.js";
import { registerUpsertProcess } from "../../src/tools/ti-development/upsert-process.js";
import { unplacedBlobContent } from "../../src/lib/git-process.js";
import type { TM1Client } from "../../src/tm1-client.js";

interface Calls {
  check: unknown[];
  writes: string[];
}

function client(
  opts: {
    cubes?: string[];
    exists?: boolean;
    installed?: { prolog: string; epilog: string };
    syntaxOk?: boolean;
  },
  calls: Calls,
) {
  return {
    cubes: {
      list: async () => (opts.cubes ?? []).map((name) => ({ name })),
    },
    dimensions: { list: async () => [] },
    processes: {
      check: async (input: unknown) => {
        calls.check.push(input);
        return opts.syntaxOk === false
          ? {
              success: false,
              errors: [{ procedure: "Prolog", lineNumber: 1, message: "bad" }],
            }
          : { success: true, errors: [] };
      },
      exists: async () => opts.exists ?? false,
      getCode: async () => ({
        prolog: opts.installed?.prolog ?? "",
        metadata: "",
        data: "",
        epilog: opts.installed?.epilog ?? "",
      }),
      getParameters: async () => [],
      getVariables: async () => [],
      create: async () => void calls.writes.push("create"),
      updateCode: async () => void calls.writes.push("updateCode"),
    },
  } as unknown as TM1Client;
}

describe("runPreflight", () => {
  it("fails the reference check on a cube that does not exist", async () => {
    const calls: Calls = { check: [], writes: [] };
    const failure = await runPreflight(client({ cubes: ["Sales"] }, calls), {
      name: "P",
      prolog: "CellPutN(1, 'Sales Plan', 'a');",
      metadata: "",
      data: "",
      epilog: "",
    });
    expect(failure).toMatchObject({
      stage: "preflight",
      check: "references",
      code: "VALIDATION_ERROR",
      issues: [{ kind: "cube", name: "Sales Plan" }],
    });
    expect(failure!.message).toContain("cube 'Sales Plan' not found");
    expect(failure!.hint).toContain("preflight:false skips BOTH");
  });

  it("stops at the syntax check before the reference check", async () => {
    const calls: Calls = { check: [], writes: [] };
    const failure = await runPreflight(client({ syntaxOk: false }, calls), {
      name: "P",
      prolog: "x",
      metadata: "",
      data: "",
      epilog: "",
    });
    expect(failure?.check).toBe("syntax");
    expect(failure?.errors).toHaveLength(1);
  });

  it("passes a payload whose names resolve", async () => {
    const calls: Calls = { check: [], writes: [] };
    expect(
      await runPreflight(client({ cubes: ["Sales"] }, calls), {
        name: "P",
        prolog: "CellPutN(1, 'Sales', 'a');",
        metadata: "",
        data: "",
        epilog: "",
      }),
    ).toBeUndefined();
  });
});

describe("tm1_upsert_process preflight", () => {
  function call(c: TM1Client, args: Record<string, unknown>) {
    let h: ((a: unknown) => Promise<unknown>) | null = null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    registerUpsertProcess(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      c,
    );
    return h!(parser!.parse(args)) as Promise<{
      isError?: boolean;
      content: Array<{ text: string }>;
    }>;
  }

  it("checks the installed tabs the caller did not send, and writes nothing on failure", async () => {
    const calls: Calls = { check: [], writes: [] };
    const res = await call(
      client(
        {
          exists: true,
          cubes: ["Sales"],
          installed: { prolog: "", epilog: "CellGetN('Gone', 'a');" },
        },
        calls,
      ),
      // Updates the prolog only; the installed epilog still names 'Gone'.
      { processName: "P", prolog: "CellGetN('Sales', 'a');", confirm: "P" },
    );
    expect(calls.check[0]).toMatchObject({
      prolog: "CellGetN('Sales', 'a');",
      epilog: "CellGetN('Gone', 'a');",
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).issues[0].name).toBe("Gone");
    expect(calls.writes).toEqual([]);
  });

  it("preflight:false skips both checks", async () => {
    const calls: Calls = { check: [], writes: [] };
    await call(client({ exists: false }, calls), {
      processName: "P",
      prolog: "CellGetN('Gone', 'a');",
      preflight: false,
    });
    expect(calls.check).toEqual([]);
    expect(calls.writes).toEqual(["create", "updateCode"]);
  });
});

describe("unplacedBlobContent", () => {
  const tab = (name: string, body: string) =>
    `#region ${name}\r\n${body}\r\n#endregion\r\n`;

  it("accepts a clean four-tab blob, nested user folds included", () => {
    const blob =
      tab("Prolog", "#region helpers\r\nx = 1;\r\n#endregion") +
      tab("Metadata", "") +
      tab("Data", "") +
      tab("Epilog", "y = 2;");
    expect(unplacedBlobContent(blob)).toEqual([]);
  });

  it("reports code outside every tab region", () => {
    const blob = tab("Prolog", "x = 1;") + "CellPutN(1, 'Hidden', 'a');\r\n";
    expect(unplacedBlobContent(blob)).toEqual([
      `text outside any tab region: "CellPutN(1, 'Hidden', 'a');"`,
    ]);
  });

  it("reports a tab region that appears twice", () => {
    const blob = tab("Prolog", "x = 1;") + tab("prolog", "y = 2;");
    expect(unplacedBlobContent(blob)).toEqual(["#region prolog appears twice"]);
  });
});
