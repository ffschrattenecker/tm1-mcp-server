import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerUpsertProcess } from "../../src/tools/ti-development/upsert-process.js";
import type { TM1Client } from "../../src/tm1-client.js";

type Code = { prolog: string; metadata: string; data: string; epilog: string };

// A process store that remembers what updateCode wrote, so the read-back
// check sees the real post-write state.
function client(opts: {
  installed?: Partial<Code>;
  cubes?: string[];
  syntaxOk?: boolean;
  dropWrites?: boolean;
}) {
  const writes: string[] = [];
  let code: Code | null = opts.installed
    ? { prolog: "", metadata: "", data: "", epilog: "", ...opts.installed }
    : null;
  const c = {
    cubes: { list: async () => (opts.cubes ?? []).map((name) => ({ name })) },
    dimensions: { list: async () => [] },
    processes: {
      exists: async () => code !== null,
      check: async () =>
        opts.syntaxOk === false
          ? {
              success: false,
              errors: [{ procedure: "Prolog", lineNumber: 1, message: "bad" }],
            }
          : { success: true, errors: [] },
      getCode: async () =>
        code ?? { prolog: "", metadata: "", data: "", epilog: "" },
      getParameters: async () => [],
      getVariables: async () => [],
      create: async () => {
        writes.push("create");
        code = { prolog: "", metadata: "", data: "", epilog: "" };
      },
      updateCode: async (_n: string, tabs: Partial<Code>) => {
        writes.push("updateCode");
        if (!opts.dropWrites) code = { ...code!, ...tabs };
      },
    },
  } as unknown as TM1Client;
  return { c, writes };
}

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

describe("tm1_upsert_process dryRun", () => {
  it("reports both checks and the diff without confirm, and writes nothing", async () => {
    const { c, writes } = client({
      installed: { prolog: "x = 1;" },
      cubes: ["Sales"],
      syntaxOk: false,
    });
    const res = await call(c, {
      processName: "P",
      prolog: "CellPutN(1, 'Sales Plan', 'a');",
      dryRun: true,
    });
    const out = JSON.parse(res.content[0].text);
    expect(res.isError).toBeUndefined();
    expect(out).toMatchObject({
      dryRun: true,
      action: "wouldUpdate",
      appliedSteps: [],
      needsConfirm: "P",
      checks: {
        ok: false,
        syntax: { ok: false },
        // The reference check runs although the syntax check failed.
        references: { ok: false, issues: [{ name: "Sales Plan" }] },
      },
      diff: { identical: false, tabs: { prolog: { identical: false } } },
    });
    expect(writes).toEqual([]);
  });

  it("is not a confirmation: the real overwrite still needs confirm", async () => {
    const { c, writes } = client({ installed: { prolog: "x = 1;" } });
    await call(c, { processName: "P", prolog: "x = 2;", dryRun: true });
    await expect(
      call(c, { processName: "P", prolog: "x = 2;" }),
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("masks credentials in the diff", async () => {
    const { c } = client({
      installed: { prolog: "sPwd = 'old-secret';" },
    });
    const res = await call(c, {
      processName: "P",
      prolog: "sPwd = 'new-secret';",
      dryRun: true,
    });
    expect(res.content[0].text).not.toContain("secret");
  });

  it("marks a create as wouldCreate with no confirm needed", async () => {
    const { c } = client({});
    const out = JSON.parse(
      (await call(c, { processName: "P", prolog: "x = 1;", dryRun: true }))
        .content[0].text,
    );
    expect(out.action).toBe("wouldCreate");
    expect(out.needsConfirm).toBeUndefined();
    expect(out.checks.ok).toBe(true);
  });
});

describe("tm1_upsert_process read-back", () => {
  it("verifies the stored code matches what was sent", async () => {
    const { c } = client({});
    const out = JSON.parse(
      (await call(c, { processName: "P", prolog: "x = 1;" })).content[0].text,
    );
    expect(out.verified).toEqual({ codeMatches: true, mismatchedTabs: [] });
  });

  it("names the tabs that did not land", async () => {
    const { c } = client({ installed: { prolog: "old" }, dropWrites: true });
    const out = JSON.parse(
      (await call(c, { processName: "P", prolog: "new", confirm: "P" }))
        .content[0].text,
    );
    expect(out.verified).toEqual({
      codeMatches: false,
      mismatchedTabs: ["prolog"],
    });
  });
});
