import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { DataSource } from "../../src/types.js";
import { registerGetProcess } from "../../src/tools/ti-development/get-process.js";
import { registerGetAllProcessesCode } from "../../src/tools/ti-development/get-all-processes-code.js";
import { registerExportProcessToPro } from "../../src/tools/ti-development/export-process-to-pro.js";
import { registerExportProcessToGit } from "../../src/tools/ti-development/export-process-to-git.js";
import { registerDiffProcesses } from "../../src/tools/ti-development/diff-processes.js";
import { registerDiffProcessWithFile } from "../../src/tools/ti-development/diff-process-with-file.js";
import { serializeToPro } from "../../src/lib/pro-serializer.js";

// Finding #1: five code-reading tools returned/wrote TI code verbatim, leaking
// inline ODBC credentials. Each now masks the code payload by default.

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// S8 (2026-08-05): `maskSecrets:false` is a MODEL-controlled opt-out of a
// security control, so it now requires operator consent out-of-band. The cases
// below that assert RAW output grant that consent — they exercise each tool's
// masking logic, not the gate. The gate itself is asserted once at the bottom
// of this file and exhaustively in tests/unit/mask-secrets.test.ts.
beforeEach(() => {
  process.env.TM1_ALLOW_UNMASKED_SECRETS = "true";
});
afterEach(() => {
  delete process.env.TM1_ALLOW_UNMASKED_SECRETS;
});

// Capture the raw zod shape + handler a register* fn passes to server.tool, then
// run inputs through z.object(shape).parse to apply schema defaults (maskSecrets
// defaults to true) exactly as the live SDK would before the handler runs.
function capture(
  register: (server: McpServer, client: TM1Client) => void,
  client: TM1Client,
): { schema: ZodRawShape; handler: Handler } {
  let schema: ZodRawShape | undefined;
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _desc: string, s: ZodRawShape, h: Handler) => {
      schema = s;
      handler = h;
    },
  } as unknown as McpServer;
  register(server, client);
  if (!schema || !handler) throw new Error("tool was not registered");
  return { schema, handler };
}

async function run(
  register: (server: McpServer, client: TM1Client) => void,
  client: TM1Client,
  input: Record<string, unknown>,
): Promise<string> {
  const { schema, handler } = capture(register, client);
  const args = z.object(schema).parse(input);
  const res = await handler(args, {});
  return res.content[0].text;
}

const NONE_DS: DataSource = { type: "None" };
const ODBC = (pw: string) => `ODBCOpen('SalesDSN', 'svc_user', '${pw}');`;

// Bulk-code stub mirroring the ProcessService.getAllCode overload: plain array
// without a cap, { items, total } when the tool pushes $top server-side.
function bulkCodeClient(
  rows: Array<{
    name: string;
    prolog: string;
    metadata: string;
    data: string;
    epilog: string;
    hasSecurityAccess: boolean;
  }>,
  opts?: { omitCount?: boolean },
): TM1Client {
  return contractCheckedClient({
    processes: {
      getAllCode: async (_includeControl?: boolean, top?: number) =>
        top === undefined
          ? rows
          : {
              items: rows.slice(0, top),
              total: opts?.omitCount ? undefined : rows.length,
            },
    },
  } as unknown as TM1Client);
}

// A processes stub whose getCode returns per-process code maps.
function clientWith(
  codeByProcess: Record<string, Record<string, string>>,
): TM1Client {
  return contractCheckedClient({
    processes: {
      getCode: async (name: string) => {
        const c = codeByProcess[name] ?? {};
        return {
          prolog: c.prolog ?? "",
          metadata: c.metadata ?? "",
          data: c.data ?? "",
          epilog: c.epilog ?? "",
        };
      },
      getCodeBlob: async (name: string) => {
        const c = codeByProcess[name] ?? {};
        // Reconstruct the blob from structured code: prolog + metadata + data + epilog
        return (
          (c.prolog ?? "") +
          (c.metadata ?? "") +
          (c.data ?? "") +
          (c.epilog ?? "")
        );
      },
      getParameters: async () => [],
      getVariables: async () => [],
      getVariableLayout: async () => ({ variables: [], ignoredColumns: [] }),
      getDataSource: async () => NONE_DS,
      getUIData: async () => ({}),
      getDeployMeta: async () => ({ hasSecurityAccess: false }),
      getGitHeader: async (name: string) => ({
        Name: name,
        HasSecurityAccess: false,
        DataSource: { Type: "None" },
        Parameters: [],
        Variables: [],
      }),
    },
  } as unknown as TM1Client);
}

const SALES_SECRET = "S3cr3t_Pw!";
const SALES = clientWith({ "Load.Sales": { prolog: ODBC(SALES_SECRET) } });

// Same ODBC password on both sides; a nearby non-secret change forces the
// ODBCOpen line into the diff as a context line.
const DIFF_SECRET = "S3cr3t_Pw!";
const DIFF = clientWith({
  A: { prolog: `${ODBC(DIFF_SECRET)}\nsX = 1;` },
  B: { prolog: `${ODBC(DIFF_SECRET)}\nsX = 2;` },
});

// Audit 2026-07-12: the bulk code tool was the sole code-returning tool that
// skipped masking.
const BULK_SECRET = "Bulk_Pw!";
const BULK = bulkCodeClient([
  {
    name: "Load.Sales",
    prolog: ODBC(BULK_SECRET),
    metadata: "",
    data: "",
    epilog: "",
    hasSecurityAccess: false,
  },
]);

// [tool, register, client, input, secret that must not leak by default]
const MASKED_TOOLS: Array<
  [
    string,
    (server: McpServer, client: TM1Client) => void,
    TM1Client,
    Record<string, unknown>,
    string,
  ]
> = [
  [
    "tm1_get_process",
    registerGetProcess,
    SALES,
    { processName: "Load.Sales" },
    SALES_SECRET,
  ],
  [
    "tm1_export_process_to_pro (.pro content)",
    registerExportProcessToPro,
    SALES,
    { processName: "Load.Sales" },
    SALES_SECRET,
  ],
  [
    "tm1_export_process_to_git (.ti content)",
    registerExportProcessToGit,
    SALES,
    { processName: "Load.Sales" },
    SALES_SECRET,
  ],
  [
    "tm1_diff_processes (hunk lines)",
    registerDiffProcesses,
    DIFF,
    { processA: "A", processB: "B" },
    DIFF_SECRET,
  ],
  [
    "tm1_get_all_processes_code (every tab)",
    registerGetAllProcessesCode,
    BULK,
    {},
    BULK_SECRET,
  ],
];

describe("code-reading tools mask inline ODBC credentials", () => {
  it.each(MASKED_TOOLS)(
    "%s masks the password by default",
    async (_name, register, client, input, secret) => {
      const text = await run(register, client, input);
      expect(text).not.toContain(secret);
      expect(text).toContain("***");
    },
  );

  it.each(MASKED_TOOLS)(
    "%s returns the raw password when maskSecrets=false",
    async (_name, register, client, input, secret) => {
      const text = await run(register, client, {
        ...input,
        maskSecrets: false,
      });
      expect(text).toContain(secret);
    },
  );
});

describe("tm1_export_process_to_git writeToDir and writeToFile persistence", () => {
  const client = SALES;
  let root: string;
  let prevRoot: string | undefined;

  beforeEach(async () => {
    prevRoot = process.env.TM1_LOCAL_FILE_ROOT;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tm1-git-mask-"));
    process.env.TM1_LOCAL_FILE_ROOT = root;
  });
  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
    else process.env.TM1_LOCAL_FILE_ROOT = prevRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  // The written file is the deployable copy. Masking it made a re-import deploy
  // ODBCOpen(..., '***'), so the file keeps the code as is; masking applies to
  // the inline copy that goes to the model.
  it("writes the unmasked .ti to disk so it re-imports intact", async () => {
    await run(registerExportProcessToGit, client, {
      processName: "Load.Sales",
      writeToDir: root,
    });
    const onDisk = await fs.readFile(path.join(root, "Load.Sales.ti"), "utf8");
    expect(onDisk).toContain(SALES_SECRET);
    expect(onDisk).not.toContain("***");
  });

  // When persisting to disk the caller has the files, so the full code bodies
  // must NOT be echoed back — otherwise every export doubles into the context
  // window. Metadata (filenames, counts, writtenTo paths) still comes back.
  it("omits json/ti from the response when writeToDir is set", async () => {
    const text = await run(registerExportProcessToGit, client, {
      processName: "Load.Sales",
      writeToDir: root,
    });
    const res = JSON.parse(text) as Record<string, unknown>;
    expect(res.json).toBeUndefined();
    expect(res.ti).toBeUndefined();
    expect(res.jsonFileName).toBe("Load.Sales.json");
    expect(res.tiFileName).toBe("Load.Sales.ti");
    expect(res.writtenTo).toMatchObject({
      json: path.join(root, "Load.Sales.json"),
      ti: path.join(root, "Load.Sales.ti"),
    });
  });

  // A not-yet-existing subdir below the root must be created (mkdir -p) after
  // confinement instead of surfacing a raw ENOENT.
  it("creates a missing subdirectory below the root before writing", async () => {
    const nested = path.join(root, "exports", "sales");
    const text = await run(registerExportProcessToGit, client, {
      processName: "Load.Sales",
      writeToDir: nested,
    });
    const res = JSON.parse(text) as Record<string, unknown>;
    expect(res.writtenTo).toMatchObject({
      json: path.join(nested, "Load.Sales.json"),
      ti: path.join(nested, "Load.Sales.ti"),
    });
    const onDisk = await fs.readFile(
      path.join(nested, "Load.Sales.ti"),
      "utf8",
    );
    expect(onDisk).toContain(SALES_SECRET);
  });

  // The same ENOENT gap existed on tm1_export_process_to_pro's writeToFile.
  it("tm1_export_process_to_pro creates missing parent dirs for writeToFile", async () => {
    const target = path.join(root, "pro", "deep", "Load.Sales.pro");
    const text = await run(registerExportProcessToPro, client, {
      processName: "Load.Sales",
      writeToFile: target,
    });
    const res = JSON.parse(text) as Record<string, unknown>;
    expect(res.writtenTo).toBe(target);
    const onDisk = await fs.readFile(target, "utf8");
    expect(onDisk).toContain(SALES_SECRET);
    // ...while the inline copy the model sees stays masked.
    expect(String(res.content)).not.toContain(SALES_SECRET);
  });

  it("echoes json/ti inline when writeToDir is omitted", async () => {
    const text = await run(registerExportProcessToGit, client, {
      processName: "Load.Sales",
    });
    const res = JSON.parse(text) as Record<string, unknown>;
    expect(typeof res.json).toBe("string");
    expect(typeof res.ti).toBe("string");
    expect(res.writtenTo).toMatchObject({ json: null, ti: null });
  });
});

describe("tm1_diff_process_with_file masks both sides before diffing", () => {
  // Installed and file differ ONLY in the ODBC password. Masking both sides
  // collapses them to the same literal, so the tab reports identical.
  const client = clientWith({ "Load.Sales": { prolog: ODBC("INSTALLED_Pw") } });
  const fileContent = serializeToPro({
    name: "Load.Sales",
    prolog: ODBC("FILE_Pw"),
    metadata: "",
    data: "",
    epilog: "",
    parameters: [],
    variables: [],
    dataSource: NONE_DS,
  });

  it("reports the prolog tab identical when only the password differs (default mask)", async () => {
    const text = await run(registerDiffProcessWithFile, client, {
      content: fileContent,
    });
    const parsed = JSON.parse(text) as {
      tabs: Array<{ tab: string; identical: boolean }>;
    };
    const prolog = parsed.tabs.find((t) => t.tab === "prolog")!;
    expect(prolog.identical).toBe(true);
    expect(text).not.toContain("INSTALLED_Pw");
    expect(text).not.toContain("FILE_Pw");
  });

  it("reports the prolog tab differing when maskSecrets=false", async () => {
    const text = await run(registerDiffProcessWithFile, client, {
      content: fileContent,
      maskSecrets: false,
    });
    const parsed = JSON.parse(text) as {
      tabs: Array<{ tab: string; identical: boolean }>;
    };
    const prolog = parsed.tabs.find((t) => t.tab === "prolog")!;
    expect(prolog.identical).toBe(false);
  });
});

// L5: summary mode drops the tab bodies and reports line metrics instead
// (mirrors tm1_get_all_cube_rules summary mode).
describe("tm1_get_all_processes_code summary mode", () => {
  const prolog = ["# header", "# more header", ODBC("Sum_Pw!"), "x = 1;"].join(
    "\n",
  );
  const client = bulkCodeClient([
    {
      name: "Load.Sales",
      prolog,
      metadata: "# meta only",
      data: "",
      epilog: "y = 2;",
      hasSecurityAccess: true,
    },
  ]);

  it("returns per-process line metrics and no code bodies", async () => {
    const text = await run(registerGetAllProcessesCode, client, {
      summary: true,
    });
    const parsed = JSON.parse(text) as {
      count: number;
      returned: number;
      truncated: boolean;
      processes: Array<Record<string, unknown>>;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.returned).toBe(1);
    expect(parsed.truncated).toBe(false);
    // Exact-shape assert: metrics present, none of the four tab bodies.
    expect(parsed.processes[0]).toEqual({
      name: "Load.Sales",
      hasSecurityAccess: true,
      totalLines: 6,
      prologLines: 4,
      metadataLines: 1,
      dataLines: 0,
      epilogLines: 1,
      commentLines: 3,
    });
  });

  it("leaks no credentials even with maskSecrets=false (no code returned)", async () => {
    const text = await run(registerGetAllProcessesCode, client, {
      summary: true,
      maskSecrets: false,
    });
    expect(text).not.toContain("Sum_Pw!");
    expect(text).not.toContain("ODBCOpen");
  });

  it("default mode is unchanged: tab bodies present, no metric fields", async () => {
    const text = await run(registerGetAllProcessesCode, client, {});
    const parsed = JSON.parse(text) as {
      processes: Array<Record<string, unknown>>;
    };
    expect(parsed.processes[0].prolog).toContain("ODBCOpen");
    expect(parsed.processes[0].totalLines).toBeUndefined();
  });
});

// Token-opt 2026-07-18: full-code responses default-cap at 50 processes
// (server-side $top); summary mode still surveys the whole model by default.
describe("tm1_get_all_processes_code default cap", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    name: `Proc.${String(i).padStart(2, "0")}`,
    prolog: "x = 1;",
    metadata: "",
    data: "",
    epilog: "",
    hasSecurityAccess: false,
  }));
  const client = bulkCodeClient(rows);

  it("caps full-code responses at 50 by default and flags truncation", async () => {
    const text = await run(registerGetAllProcessesCode, client, {});
    const parsed = JSON.parse(text) as {
      count: number;
      countIsExact: boolean;
      returned: number;
      truncated: boolean;
      processes: unknown[];
    };
    expect(parsed.returned).toBe(50);
    expect(parsed.processes).toHaveLength(50);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
    expect(parsed.countIsExact).toBe(true);
  });

  it("flags count as inexact lower bound when truncated and @odata.count is absent", async () => {
    const noCountClient = bulkCodeClient(rows, { omitCount: true });
    const parsed = JSON.parse(
      await run(registerGetAllProcessesCode, noCountClient, {}),
    ) as {
      count: number;
      countIsExact: boolean;
      truncated: boolean;
    };
    expect(parsed.truncated).toBe(true);
    // Sentinel fetch saw cap+1 rows — count is a lower bound, not the model total.
    expect(parsed.count).toBe(51);
    expect(parsed.countIsExact).toBe(false);
  });

  it.each([
    ["an explicit limit overrides the default cap", { limit: 10 }, 10, true],
    ["limit=0 returns everything uncapped", { limit: 0 }, 60, false],
    [
      "summary mode surveys all processes by default",
      { summary: true },
      60,
      false,
    ],
    [
      "an explicit limit also caps summary mode",
      { summary: true, limit: 5 },
      5,
      true,
    ],
  ])("%s", async (_label, input, returned, truncated) => {
    const parsed = JSON.parse(
      await run(registerGetAllProcessesCode, client, input),
    ) as { count: number; returned: number; truncated: boolean };
    expect(parsed.returned).toBe(returned);
    expect(parsed.truncated).toBe(truncated);
    expect(parsed.count).toBe(60);
  });
});

// S8 end-to-end: the gate has to bite at the TOOL boundary, not only inside the
// helper. Without operator consent a model asking for raw credentials gets
// masked output anyway — and the call still succeeds, so an audit is degraded
// rather than broken. The gate's value handling is covered in mask-secrets.test.ts.
describe("maskSecrets=false is ignored without operator consent", () => {
  it("masks anyway when TM1_ALLOW_UNMASKED_SECRETS is unset", async () => {
    delete process.env.TM1_ALLOW_UNMASKED_SECRETS;
    const text = await run(registerGetProcess, SALES, {
      processName: "Load.Sales",
      maskSecrets: false,
    });
    expect(text).not.toContain(SALES_SECRET);
    expect(text).toContain("***");
  });
});

describe("tm1_diff_processes on long tabs", () => {
  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `v${tag}${i} = ${i};`).join("\n");

  it("diffs a one-line edit in a long tab with correct positions", async () => {
    const base = lines(20_000, "x").split("\n");
    const edited = [...base];
    edited[9_999] = "vChanged = 1;";
    const client = clientWith({
      A: { prolog: base.join("\n") },
      B: { prolog: edited.join("\n") },
    });
    const out = JSON.parse(
      await run(registerDiffProcesses, client, {
        processA: "A",
        processB: "B",
        tabs: ["prolog"],
      }),
    );
    const tab = out.tabs.prolog;
    expect(tab.tooLarge).toBeUndefined();
    expect(tab.hunks).toHaveLength(1);
    expect(tab.hunks[0]).toMatchObject({
      startA: 9_997,
      countA: 7,
      startB: 9_997,
      countB: 7,
    });
  });

  it("reports tooLarge instead of building an oversized table", async () => {
    const client = clientWith({
      A: { prolog: lines(5_000, "a") },
      B: { prolog: lines(5_000, "b") },
    });
    const out = JSON.parse(
      await run(registerDiffProcesses, client, {
        processA: "A",
        processB: "B",
        tabs: ["prolog"],
      }),
    );
    expect(out.tabs.prolog).toEqual({
      identical: false,
      linesA: 5_000,
      linesB: 5_000,
      hunks: [],
      tooLarge: true,
    });
  });
});
