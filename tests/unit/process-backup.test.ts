import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { registerUpsertProcess } from "../../src/tools/ti-development/upsert-process.js";
import { registerImportProcessFromGit } from "../../src/tools/ti-development/import-process-from-git.js";
import { registerInstallProBundle } from "../../src/tools/ti-development/install-pro-bundle.js";
import { safeFileName } from "../../src/tools/ti-development/process-backup.js";
import { TM1Client } from "../../src/tm1-client.js";

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

// The installed version carries a credential literal: the backup must keep
// it, or restoring it installs a process that fails at runtime.
const INSTALLED_TI =
  "#region Prolog\r\nODBCOpen('dsn', 'user', 'hunter2');\r\n#endregion\r\n";

let root: string;

function fakeClient(installed: string[], writes: string[]) {
  const backupsAtWrite = () =>
    existsSync(root) ? readdirSync(root, { recursive: true }).length : 0;
  const write = (what: string) =>
    void writes.push(`${what} (backup files: ${backupsAtWrite()})`);
  return {
    connectionId: "tm1host_8010",
    cubes: { list: async () => [] },
    dimensions: { list: async () => [] },
    processes: {
      exists: async (n: string) => installed.includes(n),
      list: async () => installed.map((name) => ({ name })),
      check: async () => ({ success: true, errors: [] }),
      getCode: async () => ({ prolog: "", metadata: "", data: "", epilog: "" }),
      getCodeBlob: async () => INSTALLED_TI,
      getParameters: async () => [
        { name: "pYear", type: "String", defaultValue: "2026", prompt: "" },
      ],
      getVariables: async () => [],
      getVariableLayout: async () => ({ variables: [] }),
      getDataSource: async () => ({ type: "None" }),
      getDeployMeta: async () => ({ hasSecurityAccess: false }),
      create: async (n: string) => write(`create ${n}`),
      updateCode: async (n: string) => write(`code ${n}`),
      updateCodeBlob: async (n: string) => write(`code ${n}`),
      updateParameters: async () => undefined,
      updateVariables: async () => undefined,
      updateDataSource: async () => undefined,
      updateSecurityAccess: async () => undefined,
    },
  };
}

function backupFiles(): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.(json|ti)$/.test(f))
    .sort();
}

beforeEach(() => {
  root = path.join(mkdtempSync(path.join(tmpdir(), "backup-")), "backups");
  process.env.TM1_PROCESS_BACKUP_DIR = root;
});

afterEach(() => {
  process.env.TM1_PROCESS_BACKUP_DIR = "off";
  delete process.env.TM1_LOCAL_FILE_ROOT;
});

describe("process backup before overwrite", () => {
  it("upsert_process saves the installed version before the first write", async () => {
    const writes: string[] = [];
    const res = await call(registerUpsertProcess, fakeClient(["P"], writes), {
      processName: "P",
      prolog: "x = 1;",
      confirm: "P",
    });
    const { backup } = JSON.parse(res.content[0].text);
    expect(writes).toEqual(["code P (backup files: 4)"]);
    expect(path.dirname(backup.json)).toBe(
      path.join(root, "tm1host_8010", "P"),
    );
    expect(readFileSync(backup.ti, "utf8")).toBe(INSTALLED_TI);
    const json = JSON.parse(readFileSync(backup.json, "utf8"));
    expect(json.name).toBe("P");
    expect(json.parameters[0].name).toBe("pYear");
  });

  it("preflight:false still backs up", async () => {
    const writes: string[] = [];
    const res = await call(registerUpsertProcess, fakeClient(["P"], writes), {
      processName: "P",
      prolog: "x = 1;",
      confirm: "P",
      preflight: false,
    });
    expect(JSON.parse(res.content[0].text).backup).toBeDefined();
    expect(backupFiles()).toHaveLength(2);
  });

  it("a create makes no backup", async () => {
    const writes: string[] = [];
    const res = await call(registerUpsertProcess, fakeClient([], writes), {
      processName: "New",
      prolog: "x = 1;",
    });
    expect(JSON.parse(res.content[0].text).backup).toBeUndefined();
    expect(backupFiles()).toEqual([]);
  });

  it("a refused confirm makes no backup", async () => {
    await expect(
      call(registerUpsertProcess, fakeClient(["P"], []), {
        processName: "P",
        prolog: "x = 1;",
        confirm: "p",
      }),
    ).rejects.toThrow(/confirm mismatch/);
    expect(backupFiles()).toEqual([]);
  });

  it("a failed preflight makes no backup", async () => {
    const res = await call(registerUpsertProcess, fakeClient(["P"], []), {
      processName: "P",
      prolog: "CellPutN(1, 'Missing Cube', 'a');",
      confirm: "P",
    });
    expect(res.content[0].text).toContain("preflight");
    expect(backupFiles()).toEqual([]);
  });

  it("a backup that cannot be written refuses the overwrite", async () => {
    // A file where the directory should be: mkdir fails.
    mkdirSync(path.dirname(root), { recursive: true });
    writeFileSync(root, "not a directory");
    const writes: string[] = [];
    await expect(
      call(registerUpsertProcess, fakeClient(["P"], writes), {
        processName: "P",
        prolog: "x = 1;",
        confirm: "P",
      }),
    ).rejects.toThrow(/Backup of process 'P' failed .* Nothing was written/);
    expect(writes).toEqual([]);
  });

  it("TM1_PROCESS_BACKUP_DIR=off overwrites without a backup", async () => {
    process.env.TM1_PROCESS_BACKUP_DIR = "OFF";
    const writes: string[] = [];
    const res = await call(registerUpsertProcess, fakeClient(["P"], writes), {
      processName: "P",
      prolog: "x = 1;",
      confirm: "P",
    });
    expect(JSON.parse(res.content[0].text).backup).toBeUndefined();
    expect(writes).toEqual(["code P (backup files: 0)"]);
  });

  it("import_process_from_git backs up, and its backup is a valid import", async () => {
    const writes: string[] = [];
    const client = fakeClient(["P"], writes);
    const res = await call(registerImportProcessFromGit, client, {
      jsonContent: JSON.stringify({ name: "P", parameters: [], variables: [] }),
      tiContent: "#region Prolog\r\nx = 1;\r\n#endregion\r\n",
      confirm: "P",
      preflight: false,
    });
    const { backup } = JSON.parse(res.content[0].text);
    expect(writes[0]).toBe("code P (backup files: 4)");
    // The restore path: feed the backup straight back in.
    const restored = await call(registerImportProcessFromGit, client, {
      jsonContent: readFileSync(backup.json, "utf8"),
      tiContent: readFileSync(backup.ti, "utf8"),
      confirm: "P",
      preflight: false,
    });
    expect(JSON.parse(restored.content[0].text).action).toBe("updated");
  });

  it("install_pro_bundle: dryRun saves nothing, the install backs up each overwrite", async () => {
    const bundleRoot = mkdtempSync(path.join(tmpdir(), "bundle-"));
    const dir = path.join(bundleRoot, "lib");
    mkdirSync(dir);
    const pro = (name: string) =>
      ["601,100", `602,"${name}"`, '562,"NULL"', "572,1", "x = 1;", ""].join(
        "\r\n",
      );
    writeFileSync(path.join(dir, "a.pro"), pro("A"));
    writeFileSync(path.join(dir, "b.pro"), pro("B"));
    process.env.TM1_LOCAL_FILE_ROOT = bundleRoot;

    await call(registerInstallProBundle, fakeClient(["B"], []), {
      directory: dir,
      dryRun: true,
    });
    expect(backupFiles()).toEqual([]);

    const res = await call(registerInstallProBundle, fakeClient(["B"], []), {
      directory: dir,
      confirm: "lib",
    });
    const results = JSON.parse(res.content[0].text).results as Array<{
      processName: string;
      backup?: { json: string };
    }>;
    expect(results.find((r) => r.processName === "A")!.backup).toBeUndefined();
    expect(results.find((r) => r.processName === "B")!.backup!.json).toContain(
      path.join("tm1host_8010", "B"),
    );
  });
});

describe("import on an update replaces the whole definition", () => {
  it("applies an empty parameter list, variable layout and a None datasource", async () => {
    process.env.TM1_PROCESS_BACKUP_DIR = "off";
    const client = fakeClient(["P"], []);
    const applied: string[] = [];
    Object.assign(client.processes, {
      updateParameters: async (_n: string, p: unknown[]) =>
        void applied.push(`parameters ${p.length}`),
      updateVariables: async (_n: string, v: unknown[], ui?: unknown[]) =>
        void applied.push(`variables ${v.length} ui ${JSON.stringify(ui)}`),
      updateDataSource: async (_n: string, d: { type: string }) =>
        void applied.push(`datasource ${d.type}`),
    });
    await call(registerImportProcessFromGit, client, {
      jsonContent: JSON.stringify({ name: "P", parameters: [], variables: [] }),
      tiContent: "#region Prolog\r\nx = 1;\r\n#endregion\r\n",
      confirm: "P",
      preflight: false,
    });
    expect(applied).toEqual([
      "parameters 0",
      "variables 0 ui []",
      "datasource None",
    ]);
  });
});

describe("backup file names", () => {
  it("replaces characters Windows rejects", () => {
    expect(safeFileName("}bedrock.cube.clear")).toBe("}bedrock.cube.clear");
    expect(safeFileName('a:b/c\\d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(safeFileName("trailing. ")).toBe("trailing_");
    expect(safeFileName("..")).toBe("_");
  });

  it("scopes by host, port and v12 instance/database", () => {
    const get = Object.getOwnPropertyDescriptor(
      TM1Client.prototype,
      "connectionId",
    )!.get!;
    expect(
      get.call({ config: { baseUrl: "https://tm1.local:8010/api/v1" } }),
    ).toBe("tm1.local_8010");
    expect(
      get.call({
        config: {
          baseUrl: "https://pa.example.com",
          instance: "tm1",
          database: "Planning",
        },
      }),
    ).toBe("pa.example.com_tm1_Planning");
  });
});
