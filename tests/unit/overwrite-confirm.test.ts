import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { registerUpsertProcess } from "../../src/tools/ti-development/upsert-process.js";
import { registerImportProFile } from "../../src/tools/ti-development/import-pro-file.js";
import { registerInstallProBundle } from "../../src/tools/ti-development/install-pro-bundle.js";
import type { TM1Client } from "../../src/tm1-client.js";

type Reg = (s: never, c: TM1Client) => void;

function call(register: Reg, c: unknown, args: Record<string, unknown>) {
  let h: ((a: unknown, e: unknown) => Promise<unknown>) | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  register(
    {
      tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
        parser = z.object(s);
        h = cb;
      },
    } as never,
    c as TM1Client,
  );
  return h!(parser!.parse(args), {}) as Promise<{
    content: Array<{ text: string }>;
  }>;
}

function fakeClient(installed: string[], writes: string[]) {
  return {
    cubes: { list: async () => [] },
    dimensions: { list: async () => [] },
    processes: {
      exists: async (n: string) => installed.includes(n),
      list: async () => installed.map((name) => ({ name })),
      check: async () => ({ success: true, errors: [] }),
      getCode: async () => ({ prolog: "", metadata: "", data: "", epilog: "" }),
      getParameters: async () => [],
      getVariables: async () => [],
      create: async (n: string) => void writes.push(`create ${n}`),
      updateCode: async (n: string) => void writes.push(`code ${n}`),
      updateParameters: async () => undefined,
      updateVariables: async () => undefined,
      updateDataSource: async () => undefined,
    },
  };
}

const pro = (name: string) =>
  ["601,100", `602,"${name}"`, '562,"NULL"', "572,1", "x = 1;", ""].join(
    "\r\n",
  );

describe("overwrite confirm", () => {
  it("upsert_process creates without confirm", async () => {
    const writes: string[] = [];
    await call(registerUpsertProcess, fakeClient([], writes), {
      processName: "New",
      prolog: "x = 1;",
    });
    expect(writes).toEqual(["create New", "code New"]);
  });

  it("upsert_process refuses to overwrite without confirm, and writes nothing", async () => {
    const writes: string[] = [];
    await expect(
      call(registerUpsertProcess, fakeClient(["Old"], writes), {
        processName: "Old",
        prolog: "x = 1;",
      }),
    ).rejects.toThrow(/already exists; overwriting it needs confirm="Old"/);
    expect(writes).toEqual([]);
    await call(registerUpsertProcess, fakeClient(["Old"], writes), {
      processName: "Old",
      prolog: "x = 1;",
      confirm: "Old",
    });
    expect(writes).toEqual(["code Old"]);
  });

  it("import_pro_file refuses a mismatched confirm on an existing process", async () => {
    const writes: string[] = [];
    await expect(
      call(registerImportProFile, fakeClient(["Old"], writes), {
        content: pro("Old"),
        confirm: "old",
      }),
    ).rejects.toThrow(/confirm mismatch/);
    expect(writes).toEqual([]);
  });
});

describe("install_pro_bundle overwrite confirm", () => {
  afterEach(() => {
    delete process.env.TM1_LOCAL_FILE_ROOT;
  });

  function bundleDir() {
    const root = mkdtempSync(path.join(tmpdir(), "bundle-"));
    const dir = path.join(root, "lib");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.pro"), pro("A"));
    writeFileSync(path.join(dir, "b.pro"), pro("B"));
    process.env.TM1_LOCAL_FILE_ROOT = root;
    return dir;
  }

  it("stops before the first write when a file would overwrite", async () => {
    const dir = bundleDir();
    const writes: string[] = [];
    await expect(
      call(registerInstallProBundle, fakeClient(["B"], writes), {
        directory: dir,
      }),
    ).rejects.toThrow(/1 file\(s\) would overwrite installed processes \(B\)/);
    expect(writes).toEqual([]);
  });

  it("dryRun lists the overwrites without confirm; confirm=<dir name> installs", async () => {
    const dir = bundleDir();
    const writes: string[] = [];
    const dry = await call(
      registerInstallProBundle,
      fakeClient(["B"], writes),
      {
        directory: dir,
        dryRun: true,
      },
    );
    expect(JSON.parse(dry.content[0].text).overwrites).toEqual(["B"]);
    await call(registerInstallProBundle, fakeClient(["B"], writes), {
      directory: dir,
      confirm: "lib",
    });
    expect(writes).toEqual(["create A", "code A", "code B"]);
  });
});
