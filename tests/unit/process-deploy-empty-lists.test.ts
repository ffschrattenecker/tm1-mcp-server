// A deploy must be able to REMOVE what the source no longer has. TM1 applies
// `Parameters: []`, `Variables: []` and `DataSource: {Type: "None"}` (measured
// on 11.8 and 12.5 on 2026-09-25); the tools used to skip exactly those
// calls, so a removed parameter or a source switched to None stayed on the
// server while the deploy reported success.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerUpsertProcess } from "../../src/tools/ti-development/upsert-process.js";
import { registerImportProcessFromGit } from "../../src/tools/ti-development/import-process-from-git.js";
import { registerImportProFile } from "../../src/tools/ti-development/import-pro-file.js";
import type { ToolRegistrar } from "../../src/tools/define-tool.js";
import { captureTool } from "../helpers/client-harness.js";

// These are overwrites: the fork asks for confirm and backs the installed
// version up first. Neither is what this file tests.
const savedBackupDir = process.env.TM1_PROCESS_BACKUP_DIR;
beforeEach(() => {
  process.env.TM1_PROCESS_BACKUP_DIR = "off";
});
afterEach(() => {
  if (savedBackupDir === undefined) delete process.env.TM1_PROCESS_BACKUP_DIR;
  else process.env.TM1_PROCESS_BACKUP_DIR = savedBackupDir;
});

const IGNORED = "IgnoredInputVarName=vsOld\fVarType=32\fColType=1165\f";
const NORMAL = "VarType=32\fColType=827\f";

function harness(
  register: ToolRegistrar,
  opts: { exists: boolean; serverUIData?: string[] },
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const processes = {
    exists: async () => opts.exists,
    list: async () => (opts.exists ? [{ name: "Load.Sales" }] : []),
    create: rec("create"),
    updateCode: rec("updateCode"),
    updateCodeBlob: rec("updateCodeBlob"),
    updateParameters: rec("updateParameters"),
    updateVariables: rec("updateVariables"),
    updateDataSource: rec("updateDataSource"),
    updateSecurityAccess: rec("updateSecurityAccess"),
    check: async () => ({ ok: true, errors: [] }),
    getVariableLayout: async () => ({
      variables: [],
      ignoredColumns: (opts.serverUIData ?? [])
        .map((u, i) => ({ position: i + 1, u }))
        .filter((c) => c.u.includes("ColType=1165")),
      ...(opts.serverUIData ? { variablesUIData: opts.serverUIData } : {}),
    }),
  };
  const { cb } = captureTool(register, { processes } as unknown as TM1Client);
  const call = cb;
  return {
    calls,
    run: async (args: Record<string, unknown>) =>
      JSON.parse(
        (await call({ confirm: "Load.Sales", ...args }, {})).content[0].text,
      ) as Record<string, unknown>,
    of: (name: string) => calls.filter((c) => c[0] === name),
  };
}

describe("tm1_upsert_process", () => {
  it("variables: [] is sent, like parameters: []", async () => {
    const h = harness(registerUpsertProcess, { exists: true });
    const out = await h.run({
      processName: "Load.Sales",
      variables: [],
      mode: "update",
    });
    expect(h.of("updateVariables")).toEqual([
      ["updateVariables", "Load.Sales", [], undefined],
    ]);
    expect(out.appliedSteps).toContain("updateProcessVariables");
  });

  it("passes variablesUIData through verbatim", async () => {
    const h = harness(registerUpsertProcess, { exists: true });
    await h.run({
      processName: "Load.Sales",
      variables: [{ name: "v1", type: "String", position: 2 }],
      variablesUIData: [IGNORED, NORMAL],
      mode: "update",
    });
    expect(h.of("updateVariables")[0]?.[3]).toEqual([IGNORED, NORMAL]);
  });

  it("warns when the kept column layout no longer fits the new variables", async () => {
    const h = harness(registerUpsertProcess, {
      exists: true,
      serverUIData: [NORMAL, IGNORED, NORMAL, NORMAL],
    });
    const out = await h.run({
      processName: "Load.Sales",
      variables: [{ name: "v1", type: "String", position: 1 }],
      mode: "update",
    });
    expect(out.warning).toMatch(/3 used and 1 ignored/);
  });

  it("stays quiet when the kept layout still fits", async () => {
    const h = harness(registerUpsertProcess, {
      exists: true,
      serverUIData: [NORMAL, IGNORED],
    });
    const out = await h.run({
      processName: "Load.Sales",
      variables: [{ name: "v1", type: "String", position: 1 }],
      mode: "update",
    });
    expect(out.warning).toBeUndefined();
  });
});

describe("imports apply empty lists and a None source", () => {
  it("tm1_import_process_from_git", async () => {
    const h = harness(registerImportProcessFromGit, { exists: true });
    await h.run({
      jsonContent: JSON.stringify({
        name: "Load.Sales",
        hasSecurityAccess: false,
        dataSource: { type: "None" },
        parameters: [],
        variables: [],
      }),
      tiContent: "#region Prolog\r\n#endregion\r\n",
      mode: "update",
      preflight: false,
    });
    expect(h.of("updateParameters")[0]?.[2]).toEqual([]);
    expect(h.of("updateVariables")[0]?.[2]).toEqual([]);
    expect(h.of("updateDataSource")[0]?.[2]).toMatchObject({ type: "None" });
  });

  it("tm1_import_pro_file", async () => {
    const h = harness(registerImportProFile, { exists: true });
    await h.run({
      content: [
        `602,"Load.Sales"`,
        `562,"NULL"`,
        `572,0`,
        `573,0`,
        `574,0`,
        `575,0`,
      ].join("\n"),
      mode: "update",
      preflight: false,
    });
    expect(h.of("updateParameters")[0]?.[2]).toEqual([]);
    expect(h.of("updateVariables")[0]?.[2]).toEqual([]);
    expect(h.of("updateDataSource")[0]?.[2]).toMatchObject({ type: "None" });
  });
});
