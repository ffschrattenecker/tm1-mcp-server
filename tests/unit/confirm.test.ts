import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireConfirm, CONFIRM_SCHEMA } from "../../src/tools/confirm.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerUpsertProcess } from "../../src/tools/ti-development/upsert-process.js";
import { registerImportProFile } from "../../src/tools/ti-development/import-pro-file.js";
import { registerInstallProBundle } from "../../src/tools/ti-development/install-pro-bundle.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { mockLogger, shapeOf } from "../helpers/client-harness.js";

describe("requireConfirm", () => {
  it("passes when the provided value matches the target verbatim", () => {
    expect(() =>
      requireConfirm("SalesCube", "SalesCube", "cube"),
    ).not.toThrow();
  });

  it("throws VALIDATION_ERROR on a mismatch", () => {
    try {
      requireConfirm("salescube", "SalesCube", "cube");
      expect.unreachable("should have thrown on case mismatch");
    } catch (e) {
      expect(e).toBeInstanceOf(TM1Error);
      expect((e as TM1Error).code).toBe(TM1ErrorCode.VALIDATION_ERROR);
      expect((e as TM1Error).message).toContain("SalesCube");
    }
  });

  it("throws on an empty confirm value when the target is non-empty", () => {
    expect(() => requireConfirm("", "SalesCube", "cube")).toThrow(TM1Error);
  });

  it("is not satisfied by a whitespace-padded value", () => {
    // Guards against a future refactor that trims/normalises and weakens the check.
    expect(() => requireConfirm("SalesCube ", "SalesCube", "cube")).toThrow(
      TM1Error,
    );
  });

  it("exposes a required string `confirm` field in CONFIRM_SCHEMA", () => {
    const parsed = CONFIRM_SCHEMA.confirm.safeParse(undefined);
    expect(parsed.success).toBe(false); // required, not optional
    expect(CONFIRM_SCHEMA.confirm.safeParse("x").success).toBe(true);
  });
});

// Capture each registered tool's inputSchema (the raw zod shape) by intercepting
// registerTool, mirroring tests/unit/tool-registration.test.ts.
function collectInputSchemas(): Map<string, Record<string, unknown>> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const schemas = new Map<string, Record<string, unknown>>();
  const original = server.registerTool.bind(server);
  server.registerTool = (...args: unknown[]) => {
    const name = args[0] as string;
    const config = args[1] as { inputSchema?: Record<string, unknown> };
    schemas.set(name, shapeOf(config?.inputSchema ?? {}));
    return (original as (...a: unknown[]) => unknown)(...args) as ReturnType<
      typeof server.registerTool
    >;
  };
  registerAllTools(
    withAnnotations(server, mockLogger, "readwrite"),
    {} as TM1Client,
  );
  return schemas;
}

// Tools that MUST carry the confirmation guard (CONFIRM_SCHEMA `confirm` field).
// Losing it silently would let an auto-approve client fire an irreversible
// destructive op without repeating the target name. This gate fails if any of
// these drops the field.
//
// 9.0.0: single-object deletes go through tm1_rest_write, which asks for
// confirm = the key of the object a DELETE or cancel/close action hits.
const CONFIRM_REQUIRED = [
  "tm1_rest_write",
  "tm1_files_write",
  "tm1_clear_cube",
  "tm1_delete_elements",
  // K2/S9 (2026-08-05): the guard used to cover object DESTRUCTION only, so this
  // list read as complete while irreversible writes and TI side-effects sat
  // outside it. A tool that overwrites data, or runs code whose effects the
  // caller cannot undo, belongs here just as much as a delete.
  "tm1_execute_process",
  "tm1_execute_chore",
  "tm1_write_cells",
  "tm1_set_cube_rules",
  // 5.0.0: create-or-update tools confirm an OVERWRITE (optional field, required
  // at runtime once the target exists).
  "tm1_upsert_process",
  "tm1_import_pro_file",
  "tm1_import_process_from_git",
  "tm1_install_pro_bundle",
  // …and bulk_upsert_elements when components would drop existing children.
  "tm1_bulk_upsert_elements",
];

describe("confirmation-guard coverage", () => {
  const schemas = collectInputSchemas();

  it.each(CONFIRM_REQUIRED)("%s declares a `confirm` input", (toolName) => {
    const inputSchema = schemas.get(toolName);
    expect(inputSchema, `${toolName} is not registered`).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(inputSchema, "confirm"),
      `${toolName} must declare a \`confirm\` field (CONFIRM_SCHEMA) to guard the destructive action`,
    ).toBe(true);
  });
});

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
