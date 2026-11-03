// Live PROCESS (TI development) tier: exercises the TurboIntegrator tool
// surface end-to-end against the running TM1 server. Every object it creates
// is prefixed `${SANDBOX}_PROC` and torn down in afterAll, so a stray run can
// never touch real model objects. All TI is deliberately harmless — no data
// sources touching real cubes, no CubeClearData; just parameter/variable
// assignment so compile + execute are guaranteed safe.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  names,
  restGet,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const PROC_A = `${SANDBOX}_PROC_A`;
const PROC_B = `${SANDBOX}_PROC_B`;
const PROC_BAD = `${SANDBOX}_PROC_BAD`;
const PROC_GIT_SRC = `${SANDBOX}_PROC_GIT_SRC`;
const PROC_GIT_DST = `${SANDBOX}_PROC_GIT_DST`;
const PROC_SEC = `${SANDBOX}_PROC_SEC`;

// Trivial, self-contained TI body: a parameter plus a couple of harmless
// numeric/string variable assignments. Touches nothing on the server.
const PROLOG_A = [
  "# harmless self-contained TI body for live test",
  "nFoo = 1;",
  "nBar = nFoo + pAmount;",
  "sMsg = 'mcp-live-' | NumberToString( nBar );",
].join("\r\n");

/** Delete a sandbox process through tm1_rest_write; a missing one is fine. */
async function dropProcess(h: LiveHarness, name: string): Promise<void> {
  try {
    await dropIfExists(h, seg("Processes", name));
  } catch {
    /* idempotent teardown */
  }
}

/** TM1's compile errors for a process (empty when it compiles cleanly). */
async function compileErrors(h: LiveHarness, name: string): Promise<unknown[]> {
  const out = await restGet<unknown[] | undefined>(
    h,
    `${seg("Processes", name)}/tm1.Compile`,
  );
  return out ?? [];
}

describe.skipIf(!LIVE_ENABLED)("live: process (TI development)", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
    // Clean any leftovers from a previous interrupted run (idempotent).
    for (const name of [PROC_A, PROC_B, PROC_BAD, PROC_GIT_SRC, PROC_GIT_DST]) {
      await dropProcess(h, name);
    }
  });

  afterAll(async () => {
    for (const name of [PROC_A, PROC_B, PROC_BAD, PROC_GIT_SRC, PROC_GIT_DST]) {
      await dropProcess(h, name);
    }
  });

  it("check_process_code validates a harmless body without saving", async () => {
    const r = await h.ok("tm1_check_process_code", {
      processName: PROC_A,
      prolog: PROLOG_A,
      parameters: [{ name: "pAmount", type: "Numeric", defaultValue: 0 }],
      dataSource: { type: "None" },
    });
    expect(r.json).toMatchObject({ ok: true, errorCount: 0 });
    expect(r.json.errors).toEqual([]);
  });

  it("upsert_process creates PROC_A with prolog + parameter", async () => {
    const r = await h.ok("tm1_upsert_process", {
      processName: PROC_A,
      prolog: PROLOG_A,
      parameters: [
        { name: "pAmount", type: "Numeric", defaultValue: 0, prompt: "Amount" },
      ],
      mode: "upsert",
    });
    expect(r.json).toMatchObject({
      processName: PROC_A,
      action: "created",
    });
    expect(r.json.appliedSteps).toContain("createProcess");
    expect(r.json.appliedSteps).toContain("updateProcessCode");
    expect(r.json.appliedSteps).toContain("updateProcessParameters");
  });

  it("get_process returns the four tabs, parameters, variables and a datasource", async () => {
    const r = await h.ok("tm1_get_process", { processName: PROC_A });
    expect(r.json).toMatchObject({
      prolog: expect.any(String),
      metadata: expect.any(String),
      data: expect.any(String),
      epilog: expect.any(String),
      dataSource: { type: expect.any(String) },
    });
    expect(r.json.prolog).toContain("nFoo = 1;");
    expect(r.json.parameters).toBeInstanceOf(Array);
    const pAmount = r.json.parameters.find(
      (p: { name: string }) => p.name === "pAmount",
    );
    expect(pAmount).toMatchObject({ name: "pAmount", type: "Numeric" });
    expect(r.json.variables).toBeInstanceOf(Array);
  });

  it("execute_process runs the harmless process successfully", async () => {
    const r = await h.ok("tm1_execute_process", {
      processName: PROC_A,
      parameters: { pAmount: 5 },
      confirm: PROC_A,
    });
    expect(r.json).toMatchObject({
      success: true,
      processErrorStatus: "CompletedSuccessfully",
    });
  });

  it("copy_process clones PROC_A to PROC_B", async () => {
    const r = await h.ok("tm1_copy_process", {
      sourceName: PROC_A,
      targetName: PROC_B,
    });
    expect(r.json).toMatchObject({
      success: true,
      sourceName: PROC_A,
      targetName: PROC_B,
    });
  });

  it("diff_processes reports A and B as identical", async () => {
    const r = await h.ok("tm1_diff_processes", {
      processA: PROC_A,
      processB: PROC_B,
    });
    // Each tab result carries an `identical` flag; the copy should match.
    const tabs = r.json.tabResults ?? r.json.tabs ?? {};
    const flags = Object.values(tabs).map(
      (t: unknown) => (t as { identical?: boolean }).identical,
    );
    expect(flags.every((f) => f !== false)).toBe(true);
    expect(JSON.stringify(r.json)).toContain("identical");
  });

  it("diagnose_process_error returns a structured (possibly empty) log set", async () => {
    const r = await h.ok("tm1_diagnose_process_error", {
      processName: PROC_A,
      includeRelated: false,
    });
    expect(r.json).toMatchObject({
      processName: PROC_A,
      logsFound: expect.any(Number),
      logs: expect.any(Array),
    });
  });

  it("a deliberately broken process fails to compile, then diagnose runs", async () => {
    // Upsert a process with a real syntax error (unterminated statement /
    // undefined function call), compile it → expect an error envelope.
    await h.ok("tm1_upsert_process", {
      processName: PROC_BAD,
      prolog: "nX = ThisFunctionDoesNotExist( ;",
      mode: "upsert",
      // Broken on purpose — the install preflight would refuse it.
      preflight: false,
    });
    expect((await compileErrors(h, PROC_BAD)).length).toBeGreaterThan(0);

    // diagnose accepts a process name and returns a structured envelope
    // regardless of whether a runtime error log exists.
    const diag = await h.ok("tm1_diagnose_process_error", {
      processName: PROC_BAD,
      includeRelated: false,
    });
    expect(diag.json).toMatchObject({
      processName: PROC_BAD,
      logs: expect.any(Array),
    });
  });

  it("tm1_rest_write DELETE removes PROC_B (confirm gate)", async () => {
    const refused = await h.call("tm1_rest_write", {
      method: "DELETE",
      path: seg("Processes", PROC_B),
      confirm: "wrong",
    });
    expect(refused.isError).toBe(true);
    expect(await names(h, "Processes", PROC_B)).toContain(PROC_B);
    await restWrite(h, "DELETE", seg("Processes", PROC_B));
    // Gone now: get_process should error.
    const gone = await h.call("tm1_get_process", { processName: PROC_B });
    expect(gone.isError).toBe(true);
  });

  it("git export->import roundtrip preserves hasSecurityAccess", async () => {
    try {
      // 1. Seed a source process with HasSecurityAccess=true (upsert_process
      // hasSecurityAccess passthrough under test).
      await h.ok("tm1_upsert_process", {
        processName: PROC_GIT_SRC,
        prolog: "# harmless git-roundtrip source\nnX = 1;",
        hasSecurityAccess: true,
        mode: "upsert",
      });

      // 2. Export: hasSecurityAccess must be carried into the exported JSON.
      const exp1 = await h.ok("tm1_export_process_to_git", {
        processName: PROC_GIT_SRC,
      });
      expect(exp1.json.hasSecurityAccess).toBe(true);

      // 3. Retarget the exported JSON to a second process name and import
      // fresh — the canonical git-roundtrip path.
      const retargeted = (exp1.json.json as string).replace(
        `"Name": "${PROC_GIT_SRC}"`,
        `"Name": "${PROC_GIT_DST}"`,
      );
      const imp = await h.ok("tm1_import_process_from_git", {
        jsonContent: retargeted,
        tiContent: exp1.json.ti,
        mode: "upsert",
      });
      expect(imp.json.processName).toBe(PROC_GIT_DST);
      expect(imp.json.hasSecurityAccess).toBe(true);

      // 4. Re-export the second process: hasSecurityAccess must have survived
      // the second hop too.
      const exp2 = await h.ok("tm1_export_process_to_git", {
        processName: PROC_GIT_DST,
      });
      expect(exp2.json.hasSecurityAccess).toBe(true);
    } finally {
      for (const name of [PROC_GIT_SRC, PROC_GIT_DST]) {
        await dropProcess(h, name);
      }
    }
  });
});

// Deploy safety on the upsert path: the create/overwrite confirm, the install
// preflight's element reference check, and the fragment marker.
describe.skipIf(!LIVE_ENABLED)("live: process deploy safety", () => {
  let h: LiveHarness;
  const PROC = `${SANDBOX}_PROC_DEPLOY`;
  const GUARDED = `${SANDBOX}_PROC_GUARDED`;
  // Only ever written into a prolog as a string; the guard creates it at run time.
  const NEW_DIM = `${SANDBOX}_PROC_NEW_DIM`;

  const cleanup = async () => {
    await dropProcess(h, PROC);
    await dropProcess(h, GUARDED);
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
  });

  afterAll(cleanup);

  it("creates a process without confirm", async () => {
    const r = await h.ok("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 1;",
    });
    expect(r.json.action).toBe("created");
  });

  it("refuses to overwrite it without confirm, and leaves it untouched", async () => {
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 2;",
    });
    expect(r.isError).toBe(true);
    expect(r.json.message).toContain(`needs confirm="${PROC}"`);
    const code = await h.ok("tm1_get_process", { processName: PROC });
    expect(code.json.prolog).toBe("nX = 1;");
  });

  it("preflight rejects a cube that does not exist, before writing", async () => {
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: "CellPutN(1, 'Sales Plan', 'a', 'b');",
      confirm: PROC,
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      stage: "preflight",
      check: "references",
      issues: [{ kind: "cube", name: "Sales Plan" }],
    });
    const code = await h.ok("tm1_get_process", { processName: PROC });
    expect(code.json.prolog).toBe("nX = 1;");
  });

  it("preflight checks the installed tabs the call leaves alone", async () => {
    await h.ok("tm1_upsert_process", {
      processName: PROC,
      epilog: "CellGetN('Sales Plan', 'a');",
      confirm: PROC,
      preflight: false,
    });
    // Only the prolog is sent; the installed epilog still names the cube.
    const r = await h.call("tm1_upsert_process", {
      processName: PROC,
      prolog: "nX = 3;",
      confirm: PROC,
    });
    expect(r.isError).toBe(true);
    expect(r.json.issues[0]).toMatchObject({
      name: "Sales Plan",
      tab: "epilog",
    });
  });

  it("passes a guard-created dimension", async () => {
    const r = await h.ok("tm1_upsert_process", {
      processName: GUARDED,
      prolog: [
        `sDim = '${NEW_DIM}';`,
        "IF(DimensionExists(sDim) = 0);",
        "  DimensionCreate(sDim);",
        "ENDIF;",
        "DimensionElementInsertDirect(sDim, '', 'A', 'N');",
      ].join("\r\n"),
    });
    expect(r.json.action).toBe("created");
    const refs = await h.ok("tm1_validate_process_refs", {
      processName: GUARDED,
    });
    expect(refs.json).toMatchObject({ unresolved: 0, partial: false });
  });

  it("check_process_code marks a fragment as partial", async () => {
    const r = await h.ok("tm1_check_process_code", { prolog: "nX = 1;" });
    expect(r.json).toMatchObject({
      ok: true,
      tabsChecked: ["prolog"],
      partial: true,
    });
  });
});

// .pro file round trip and bundle install: export inline, diff against the
// export, import as a new process, and dry-run a bundle directory.
describe.skipIf(!LIVE_ENABLED)("live: process .pro files", () => {
  let h: LiveHarness;
  const PRO_SRC = `${SANDBOX}_PROC_PRO_SRC`;
  const PRO_IMPORT = `${SANDBOX}_PROC_PRO_IMPORT`;
  let proContent = "";
  let bundleDir = "";

  beforeAll(async () => {
    h = await getHarness();
    for (const name of [PRO_SRC, PRO_IMPORT]) {
      await dropProcess(h, name);
    }
    await h.ok("tm1_upsert_process", {
      processName: PRO_SRC,
      prolog: PROLOG_A,
      parameters: [
        { name: "pAmount", type: "Numeric", defaultValue: 0, prompt: "Amount" },
      ],
      mode: "upsert",
    });
  });

  afterAll(async () => {
    for (const name of [PRO_SRC, PRO_IMPORT]) {
      await dropProcess(h, name);
    }
    if (bundleDir) {
      try {
        await fs.rm(bundleDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("export_process_to_pro returns inline .pro content", async () => {
    const r = await h.ok("tm1_export_process_to_pro", {
      processName: PRO_SRC,
    });
    expect(r.json).toMatchObject({
      processName: PRO_SRC,
      byteLength: expect.any(Number),
      content: expect.any(String),
    });
    expect(r.json.content).toContain("602"); // .pro Name record
    proContent = r.json.content as string;
  });

  it("diff_process_with_file reports identical against its own export", async () => {
    expect(proContent).not.toBe("");
    const r = await h.ok("tm1_diff_process_with_file", {
      content: proContent,
      processName: PRO_SRC,
    });
    expect(r.json).toMatchObject({ processName: PRO_SRC, identical: true });
  });

  it("import_pro_file creates a new process from .pro content", async () => {
    expect(proContent).not.toBe("");
    const r = await h.ok("tm1_import_pro_file", {
      content: proContent,
      processName: PRO_IMPORT,
      mode: "create",
    });
    expect(JSON.stringify(r.json)).toContain(PRO_IMPORT);
    // Confirm it really landed.
    const got = await h.ok("tm1_get_process", {
      processName: PRO_IMPORT,
    });
    expect(got.json.prolog).toContain("nFoo = 1;");
  });

  it("install_pro_bundle dry-run parses a directory without writing", async () => {
    expect(proContent).not.toBe("");
    bundleDir = path.join(os.tmpdir(), "zz_mcp_live_bundle");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, `${PRO_SRC}.pro`),
      proContent,
      "utf8",
    );
    const r = await h.ok("tm1_install_pro_bundle", {
      directory: bundleDir,
      dryRun: true,
      preflight: true,
    });
    // dryRun parses + preflights and reports the *projected* per-file status
    // (e.g. "updated") without issuing create/update calls. Assert it found
    // the file, ran in dryRun mode, and hit no errors.
    expect(r.json).toMatchObject({ dryRun: true, filesFound: 1 });
    expect(r.json.counts).toMatchObject({ error: 0, preflight_failed: 0 });
  });
});

describe.skipIf(!LIVE_ENABLED)("HasSecurityAccess read paths (live)", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
    // Own fixture — the top-level "live: process" describe above tears down
    // its own processes (including PROC_A) in its afterAll, which runs before
    // this sibling describe starts, so an independent process is needed here.
    await h.ok("tm1_upsert_process", {
      processName: PROC_SEC,
      prolog: "# harmless fixture for HasSecurityAccess read paths\nnX = 1;",
      mode: "upsert",
    });
  });

  afterAll(async () => {
    await dropProcess(h, PROC_SEC);
  });

  it("getAllCode(false) returns hasSecurityAccess as a boolean on every row", async () => {
    const rows = await h.client.processes.getAllCode(false);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.hasSecurityAccess).toBe("boolean");
    }
  });

  it("getDeployMeta returns a boolean hasSecurityAccess for an existing process", async () => {
    const meta = await h.client.processes.getDeployMeta(PROC_SEC);
    expect(typeof meta.hasSecurityAccess).toBe("boolean");
  });
});

describe.skipIf(!LIVE_ENABLED)("native #region blob round-trip (live)", () => {
  let h: LiveHarness;
  const PROC_GIT_NATIVE = `${SANDBOX}_PROC_GIT_NATIVE`;

  beforeAll(async () => {
    h = await getHarness();
    // Clean any leftover from a previous interrupted run (idempotent).
    await dropProcess(h, PROC_GIT_NATIVE);
  });

  afterAll(async () => {
    await dropProcess(h, PROC_GIT_NATIVE);
  });

  it("process code round-trips via the native #region blob (getCodeBlob/updateCodeBlob), empty tab cleared", async () => {
    try {
      // Seed a process with 3 non-empty tabs; Metadata is intentionally left
      // empty to exercise the server's "omit empty tab" + "clear on full
      // replace" behavior.
      await h.client.processes.create(PROC_GIT_NATIVE);
      await h.client.processes.updateCodeBlob(
        PROC_GIT_NATIVE,
        "#region Prolog\r\nsP='p';\r\n#endregion\r\n#region Data\r\nsD='d';\r\n#endregion\r\n#region Epilog\r\nsE='e';\r\n#endregion",
      );

      // Export the blob: non-empty tabs present, the empty tab omitted by TM1.
      const blob = await h.client.processes.getCodeBlob(PROC_GIT_NATIVE);
      expect(blob).toContain("#region Prolog");
      expect(blob).toContain("#region Data");
      expect(blob).toContain("#region Epilog");
      expect(blob).not.toContain("#region Metadata"); // empty tab omitted

      // Re-import the exact exported blob (full replace) → tabs match,
      // Metadata cleared to "" since its region is absent from the blob.
      await h.client.processes.updateCodeBlob(PROC_GIT_NATIVE, blob);
      const code = await h.client.processes.getCode(PROC_GIT_NATIVE);
      expect(code.prolog).toContain("sP='p';");
      expect(code.data).toContain("sD='d';");
      expect(code.epilog).toContain("sE='e';");
      expect(code.metadata).toBe("");
    } finally {
      await dropProcess(h, PROC_GIT_NATIVE);
    }
  });
});

// Data source shapes. Every other process the live suite builds has
// `DataSource: {Type: "None"}`, so TM1 never sent an ASCII or ODBC source
// during a recording run and a dozen wire fields — the ascii* group, the
// ODBC query, the credential pair — had to be excused as unrecorded. These
// two processes make the server emit them. Neither source is ever read from:
// the file does not exist and the DSN does not resolve, and TM1 stores both
// definitions without checking, which is exactly what makes this safe.
describe.skipIf(!LIVE_ENABLED)("live: process data sources", () => {
  let h: LiveHarness;
  const PROC_DS_ASCII = `${SANDBOX}_PROC_DS_ASCII`;
  const PROC_DS_ODBC = `${SANDBOX}_PROC_DS_ODBC`;

  beforeAll(async () => {
    h = await getHarness();
    for (const name of [PROC_DS_ASCII, PROC_DS_ODBC]) {
      await dropProcess(h, name);
    }
  });

  afterAll(async () => {
    for (const name of [PROC_DS_ASCII, PROC_DS_ODBC]) {
      await dropProcess(h, name);
    }
  });

  it("round-trips an ASCII data source with every delimiter field", async () => {
    await h.ok("tm1_upsert_process", {
      processName: PROC_DS_ASCII,
      prolog: "# harmless: data source is never read",
      dataSource: {
        type: "ASCII",
        dataSourceNameForServer: `${SANDBOX}_nonexistent.csv`,
        dataSourceNameForClient: `${SANDBOX}_nonexistent.csv`,
        asciiDelimiterType: "Character",
        asciiDelimiterChar: ";",
        asciiQuoteCharacter: '"',
        asciiHeaderRecords: 1,
        asciiDecimalSeparator: ".",
        asciiThousandSeparator: ",",
      },
      mode: "upsert",
    });

    const r = await h.ok("tm1_get_process", {
      processName: PROC_DS_ASCII,
      includeCode: false,
    });
    expect(r.json.dataSource).toMatchObject({
      type: "ASCII",
      asciiDelimiterType: "Character",
      asciiDelimiterChar: ";",
      asciiQuoteCharacter: '"',
      asciiHeaderRecords: 1,
      dataSourceNameForServer: `${SANDBOX}_nonexistent.csv`,
      dataSourceNameForClient: `${SANDBOX}_nonexistent.csv`,
    });
  });

  it("round-trips an ODBC data source and redacts the password", async () => {
    await h.ok("tm1_upsert_process", {
      processName: PROC_DS_ODBC,
      prolog: "# harmless: the DSN does not resolve, nothing connects",
      dataSource: {
        type: "ODBC",
        dataSourceNameForServer: `${SANDBOX}_DSN`,
        dataSourceNameForClient: `${SANDBOX}_DSN`,
        userName: `${SANDBOX}_user`,
        password: "not-a-real-password",
        query: "SELECT 1 AS x",
      },
      mode: "upsert",
    });

    const r = await h.ok("tm1_get_process", {
      processName: PROC_DS_ODBC,
      includeCode: false,
    });
    expect(r.json.dataSource).toMatchObject({
      type: "ODBC",
      dataSourceNameForServer: `${SANDBOX}_DSN`,
      userName: `${SANDBOX}_user`,
      query: "SELECT 1 AS x",
    });
    // TM1 hands back the stored password as an encrypted blob; what must never
    // reach the caller is that blob, whatever it decrypts to.
    expect(r.json.dataSource.password).toBe("***");
    expect(r.json.dataSource.password).not.toContain("not-a-real-password");

    // The same fields on the whole-process read path, which has its own
    // wire contract.
    const full = await h.ok("tm1_get_process", { processName: PROC_DS_ODBC });
    expect(full.json.dataSource).toMatchObject({
      type: "ODBC",
      query: "SELECT 1 AS x",
    });
  });
});
