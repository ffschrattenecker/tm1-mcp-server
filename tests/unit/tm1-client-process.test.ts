import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { type TM1Client } from "../../src/tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Config } from "../../src/config.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockResponse, stubbedClient } from "../helpers/client-harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mock204Response(): Response {
  return {
    ok: true,
    status: 204,
    statusText: "No Content",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockRejectedValue(new Error("No content")),
  } as unknown as Response;
}

function mock201Response(body?: unknown): Response {
  const bodyText = body ? JSON.stringify(body) : "";
  return {
    ok: true,
    status: 201,
    statusText: "Created",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body ?? {}),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – ProcessService", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);

    const config = makeTestConfig({ requestTimeoutMs: 5000 });
    client = stubbedClient(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── executeProcess() ─────────────────────────────────────────────────────

  describe("execute()", () => {
    it("should POST tm1.ExecuteWithReturn and report success on CompletedSuccessfully", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ProcessExecuteStatusCode: "CompletedSuccessfully",
          ErrorLogFile: null,
        }),
      );

      const result = await client.processes.execute("ImportData");

      expect(result).toEqual({
        success: true,
        outcome: "succeeded",
        processErrorStatus: "CompletedSuccessfully",
        errorLogFile: undefined,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain(
        "/api/v1/Processes('ImportData')/tm1.ExecuteWithReturn",
      );
      expect(opts.method).toBe("POST");
    });

    // ErrorLogFile is a NavigationProperty on ProcessExecuteResult, so TM1 omits
    // it entirely unless it is expanded — measured on 11.8.02900.8 and 12.5.9,
    // where the unexpanded response carries ProcessExecuteStatusCode and nothing
    // else. Without this the errorLogFile field is dead on every result, so the
    // expand is asserted, not merely present.
    it("expands ErrorLogFile — without it the filename is never serialized", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ProcessExecuteStatusCode: "Aborted",
          ErrorLogFile: {
            Filename: "TM1ProcessError_20260819171009_79128800_ImportData.log",
          },
        }),
      );

      const result = await client.processes.execute("ImportData");

      expect(result.errorLogFile).toBe(
        "TM1ProcessError_20260819171009_79128800_ImportData.log",
      );
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("$expand=ErrorLogFile");
    });

    it("reports HasMinorErrors as committed-with-errors, with status + error log (HTTP 200)", async () => {
      // ExecuteWithReturn answers HTTP 200 even for partial failures — the
      // real outcome is only visible in ProcessExecuteStatusCode. The old
      // tm1.Execute path reported these runs as success. `success: false`
      // stays (fail-closed), but the outcome records that the run's writes
      // were committed, so a caller does not re-run it blindly.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ProcessExecuteStatusCode: "HasMinorErrors",
          ErrorLogFile: { Filename: "TM1ProcessError_20260718_ImportData.log" },
        }),
      );

      const result = await client.processes.execute("ImportData");

      expect(result.success).toBe(false);
      expect(result.outcome).toBe("completed_with_errors");
      expect(result.processErrorStatus).toBe("HasMinorErrors");
      expect(result.errorLogFile).toBe(
        "TM1ProcessError_20260718_ImportData.log",
      );
    });

    it("reports failure on an aborted run (HTTP 200 + Aborted status)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ProcessExecuteStatusCode: "Aborted",
          ErrorLogFile: { Filename: "TM1ProcessError_20260718_Broken.log" },
        }),
      );

      const result = await client.processes.execute("Broken");

      expect(result.success).toBe(false);
      expect(result.outcome).toBe("rolled_back");
      expect(result.processErrorStatus).toBe("Aborted");
      expect(result.errorLogFile).toBe("TM1ProcessError_20260718_Broken.log");
    });

    it("should send parameters in the request body", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("ImportData", {
        pFilePath: "/data/input.csv",
        pYear: 2024,
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual([
        { Name: "pFilePath", Value: "/data/input.csv" },
        { Name: "pYear", Value: 2024 },
      ]);
    });

    it("should send empty body when no parameters provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("SimpleProcess");

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toBeUndefined();
    });

    it("should send empty body when params is an empty object", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("SimpleProcess", {});

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toBeUndefined();
    });

    it("should return failure when TM1 returns an error", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          {
            error: {
              message: "Process aborted with error in Prolog",
            },
          },
          400,
        ),
      );

      const result = await client.processes.execute("BrokenProcess");

      expect(result.success).toBe(false);
      expect(result.processErrorStatus).toContain(
        "Process aborted with error in Prolog",
      );
    });

    it("should return failure when process is not found (404)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: "Process 'NonExistent' not found" } },
          404,
        ),
      );

      const result = await client.processes.execute("NonExistent");

      expect(result.success).toBe(false);
      expect(result.processErrorStatus).toContain("not found");
    });

    it("propagates a systemic transport failure instead of reporting success:false (M1)", async () => {
      // A network drop maps to CONNECTION_FAILED. Unlike a TI runtime error, this
      // must throw: the process may still be running server-side, so a
      // {success:false} would invite the agent to re-run it (duplicate execution).
      fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.1:8010"));

      await expect(
        client.processes.execute("LongRunningLoad"),
      ).rejects.toThrow();
    });
  });

  // ── exists() / getProcessParameters() ────────────────────────────────────

  describe("exists()", () => {
    it("returns true on 200 and probes with $select=Name (not a full list)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "ImportData" }));
      expect(await client.processes.exists("ImportData")).toBe(true);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportData')?$select=Name");
    });

    it("returns false when the process is not found (404)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { message: "not found" } }, 404),
      );
      expect(await client.processes.exists("Nope")).toBe(false);
    });

    it("rethrows a non-NOT_FOUND error instead of reporting absent", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { message: "forbidden" } }, 403),
      );
      await expect(client.processes.exists("Secret")).rejects.toThrow();
    });
  });

  describe("getParameters()", () => {
    it("should return parameters with correct type mapping", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "pFilePath",
              Type: "String",
              Value: "/data/input.csv",
              Prompt: "Enter file path",
            },
            { Name: "pYear", Type: "Numeric", Value: 2024 },
          ],
        }),
      );

      const params = await client.processes.getParameters("ImportData");

      expect(params).toEqual([
        {
          name: "pFilePath",
          type: "String",
          defaultValue: "/data/input.csv",
          prompt: "Enter file path",
        },
        { name: "pYear", type: "Numeric", defaultValue: 2024 },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportData')/Parameters");
    });

    it("should return empty array when process has no parameters", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const params = await client.processes.getParameters("NoParamProcess");
      expect(params).toEqual([]);
    });

    it("should omit prompt when not present in API response", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [{ Name: "pParam", Type: "String", Value: "default" }],
        }),
      );

      const params = await client.processes.getParameters("TestProc");
      expect(params[0]).not.toHaveProperty("prompt");
    });
  });

  // ── saveData() ────────────────────────────────────────────────────────────

  describe("saveData()", () => {
    it("should run SaveDataAll as unbound process when no cube is given", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ProcessExecuteStatusCode: "CompletedSuccessfully" }),
      );

      const result = await client.processes.saveData();

      expect(result).toEqual({
        success: true,
        outcome: "succeeded",
        processErrorStatus: "CompletedSuccessfully",
        errorLogFile: undefined,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/ExecuteProcessWithReturn");
      // Same navigation-property rule as execute(): no expand, no filename.
      expect(url).toContain("$expand=ErrorLogFile");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.Process.PrologProcedure).toBe("SaveDataAll;");
      expect(body.Process.DataSource).toEqual({ Type: "None" });
    });

    it("should run CubeSaveData for a single cube and escape quotes", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ProcessExecuteStatusCode: "CompletedSuccessfully" }),
      );

      await client.processes.saveData("Bob's Cube");

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Process.PrologProcedure).toBe("CubeSaveData('Bob''s Cube');");
    });

    it("should report failure status and error log file", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ProcessExecuteStatusCode: "CompletedWithMessages",
          ErrorLogFile: { Filename: "TM1ProcessError_x.log" },
        }),
      );

      const result = await client.processes.saveData();

      expect(result.success).toBe(false);
      expect(result.processErrorStatus).toBe("CompletedWithMessages");
      expect(result.errorLogFile).toBe("TM1ProcessError_x.log");
    });
  });

  // ── createProcess() ──────────────────────────────────────────────────────

  describe("create()", () => {
    it("should POST to /api/v1/Processes with the process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock201Response({ Name: "NewProcess" }));

      await client.processes.create("NewProcess");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ Name: "NewProcess" });
    });

    it("should throw CONFLICT error when process already exists (409)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          {
            error: { message: "Process 'Existing' already exists" },
          },
          409,
        ),
      );

      const err = await client.processes
        .create("Existing")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TM1Error);
      expect((err as TM1Error).code).toBe(TM1ErrorCode.CONFLICT);
      expect((err as TM1Error).httpStatus).toBe(409);
    });

    it("sends a name with spaces verbatim in the body", async () => {
      fetchSpy.mockResolvedValueOnce(mock201Response());

      await client.processes.create("My New Process");

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Name).toBe("My New Process");
    });
  });

  // ── getProcessCode() ─────────────────────────────────────────────────────

  describe("getCode()", () => {
    it("should return all four code tabs from the process", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "TestProcess",
          PrologProcedure: "# Prolog\nASCIIOutput('log.txt', 'start');",
          MetadataProcedure: "# Metadata",
          DataProcedure: "# Data\nCellPutN(1, 'Cube', 'e1', 'e2');",
          EpilogProcedure: "# Epilog\nASCIIOutput('log.txt', 'done');",
        }),
      );

      const code = await client.processes.getCode("TestProcess");

      expect(code).toEqual({
        prolog: "# Prolog\nASCIIOutput('log.txt', 'start');",
        metadata: "# Metadata",
        data: "# Data\nCellPutN(1, 'Cube', 'e1', 'e2');",
        epilog: "# Epilog\nASCIIOutput('log.txt', 'done');",
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
    });

    it("should return empty strings for empty code tabs", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "EmptyProcess",
          PrologProcedure: "",
          MetadataProcedure: "",
          DataProcedure: "",
          EpilogProcedure: "",
        }),
      );

      const code = await client.processes.getCode("EmptyProcess");

      expect(code.prolog).toBe("");
      expect(code.metadata).toBe("");
      expect(code.data).toBe("");
      expect(code.epilog).toBe("");
    });
  });

  // ── updateProcessCode() ──────────────────────────────────────────────────

  describe("updateCode()", () => {
    it("should PATCH only the specified tabs", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateCode("TestProcess", {
        prolog: "# New Prolog",
        data: "# New Data",
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        PrologProcedure: "# New Prolog",
        DataProcedure: "# New Data",
      });
      expect(body.MetadataProcedure).toBeUndefined();
      expect(body.EpilogProcedure).toBeUndefined();
    });

    it("should PATCH all four tabs when all are provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateCode("TestProcess", {
        prolog: "p",
        metadata: "m",
        data: "d",
        epilog: "e",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        PrologProcedure: "p",
        MetadataProcedure: "m",
        DataProcedure: "d",
        EpilogProcedure: "e",
      });
    });

    it("should PATCH a single tab", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateCode("TestProcess", {
        epilog: "# Epilog only",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ EpilogProcedure: "# Epilog only" });
    });
  });

  // ── getProcessDataSource() ───────────────────────────────────────────────

  describe("getDataSource()", () => {
    it("should return data source with type None", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "TestProcess",
          DataSource: { Type: "None" },
        }),
      );

      const ds = await client.processes.getDataSource("TestProcess");

      expect(ds).toEqual({ type: "None" });
    });

    it("should return ASCII data source with all fields", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "ImportCSV",
          DataSource: {
            Type: "ASCII",
            dataSourceNameForServer: "/data/input.csv",
            dataSourceNameForClient: "C:\\data\\input.csv",
            asciiDelimiterChar: ",",
            asciiQuoteCharacter: '"',
            asciiHeaderRecords: 1,
          },
        }),
      );

      const ds = await client.processes.getDataSource("ImportCSV");

      expect(ds).toEqual({
        type: "ASCII",
        dataSourceNameForServer: "/data/input.csv",
        dataSourceNameForClient: "C:\\data\\input.csv",
        asciiDelimiterChar: ",",
        asciiQuoteCharacter: '"',
        asciiHeaderRecords: 1,
      });
    });

    it("should return ODBC data source", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "ODBCProcess",
          DataSource: {
            Type: "ODBC",
            dataSourceNameForServer: "MyDB",
            query: "SELECT * FROM table1",
          },
        }),
      );

      const ds = await client.processes.getDataSource("ODBCProcess");

      expect(ds.type).toBe("ODBC");
      expect(ds.dataSourceNameForServer).toBe("MyDB");
      expect(ds.query).toBe("SELECT * FROM table1");
    });

    it("should omit undefined optional fields", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "SimpleProcess",
          DataSource: { Type: "None" },
        }),
      );

      const ds = await client.processes.getDataSource("SimpleProcess");

      expect(ds).toEqual({ type: "None" });
      expect(ds).not.toHaveProperty("dataSourceNameForServer");
      expect(ds).not.toHaveProperty("query");
    });
  });

  // ── updateProcessDataSource() ────────────────────────────────────────────

  describe("updateDataSource()", () => {
    it("should PATCH with DataSource object for ASCII type", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("ImportCSV", {
        type: "ASCII",
        dataSourceNameForServer: "/data/new.csv",
        asciiDelimiterChar: ";",
        asciiHeaderRecords: 2,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportCSV')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.DataSource).toEqual({
        Type: "ASCII",
        dataSourceNameForServer: "/data/new.csv",
        asciiDelimiterChar: ";",
        asciiHeaderRecords: 2,
      });
    });

    it("should PATCH with DataSource type None", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("TestProcess", { type: "None" });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.DataSource).toEqual({ Type: "None" });
    });

    it("should PATCH with ODBC data source", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("ODBCProcess", {
        type: "ODBC",
        dataSourceNameForServer: "NewDB",
        query: "SELECT id FROM users",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.DataSource.Type).toBe("ODBC");
      expect(body.DataSource.dataSourceNameForServer).toBe("NewDB");
      expect(body.DataSource.query).toBe("SELECT id FROM users");
    });

    // usesUnicode is an ODBC setting, not a version one. 11.8 rejects it for an
    // ASCII source ("unprocessed properties") and accepts it for an ODBC source,
    // where it also drives .pro line 559 — measured on both servers. The old
    // pair of tests asserted the opposite and pinned the bug in place.
    it.each([
      ["11.8", 11],
      ["12.0", 12],
    ])(
      "%s: sends usesUnicode for an ODBC source",
      async (tm1Version, version) => {
        const cfg = makeTestConfig({
          requestTimeoutMs: 5000,
          version,
          tm1Version,
        } as Partial<TM1Config>);
        const c = stubbedClient(cfg, "sess");
        fetchSpy.mockResolvedValueOnce(mock204Response());

        await c.processes.updateDataSource("ImportODBC", {
          type: "ODBC",
          dataSourceNameForServer: "DSN",
          usesUnicode: false,
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts.body);
        expect(body.DataSource.usesUnicode).toBe(false);
      },
    );

    it.each([
      ["11.8", 11],
      ["12.0", 12],
    ])(
      "%s: drops usesUnicode for a non-ODBC source",
      async (tm1Version, version) => {
        const cfg = makeTestConfig({
          requestTimeoutMs: 5000,
          version,
          tm1Version,
        } as Partial<TM1Config>);
        const c = stubbedClient(cfg, "sess");
        fetchSpy.mockResolvedValueOnce(mock204Response());

        await c.processes.updateDataSource("ImportCSV", {
          type: "ASCII",
          dataSourceNameForServer: "/data/x.csv",
          usesUnicode: true,
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts.body);
        expect(body.DataSource).not.toHaveProperty("usesUnicode");
      },
    );
  });

  // Every per-process endpoint addresses the entity by key in the URL.
  describe("process name encoding", () => {
    const emptyCode = {
      PrologProcedure: "",
      MetadataProcedure: "",
      DataProcedure: "",
      EpilogProcedure: "",
    };
    it.each([
      [
        "execute",
        () => mock204Response(),
        (c: TM1Client) => c.processes.execute("My Process"),
      ],
      [
        "getParameters",
        () => mockResponse({ value: [] }),
        (c: TM1Client) => c.processes.getParameters("My Process"),
      ],
      [
        "getCode",
        () => mockResponse(emptyCode),
        (c: TM1Client) => c.processes.getCode("My Process"),
      ],
    ] as const)(
      "%s encodes special characters in the process name",
      async (_method, response, call) => {
        fetchSpy.mockResolvedValueOnce(response());

        await call(client);

        const [url] = fetchSpy.mock.calls[0];
        expect(url).toContain("Processes('My%20Process')");
      },
    );
  });

  // Regression: TM1 v11 ignores the parameter `Type` field and classifies a
  // parameter from the JSON type of `Value`. Encoding must coerce `Value` to
  // the declared `type` (and emit the correct OData enum: String=1, Numeric=2),
  // otherwise a Numeric param whose default arrives as a string is stored as
  // String. Verified against a live PATCH+read roundtrip.
  describe("updateParameters() – parameter encoding", () => {
    it("should PATCH with Parameters array", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", [
        {
          name: "pFile",
          type: "String",
          defaultValue: "/data/in.csv",
          prompt: "File path",
        },
        { name: "pYear", type: "Numeric", defaultValue: 2024 },
      ]);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual([
        { Name: "pFile", Type: 1, Value: "/data/in.csv", Prompt: "File path" },
        { Name: "pYear", Type: 2, Value: 2024 },
      ]);
    });

    it("should send empty Parameters array when no params provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", []);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual([]);
    });

    it("encodes Numeric as Type 2 and coerces a string default to a number", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pNum", type: "Numeric", defaultValue: "0" },
      ]);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('Proc')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0]).toEqual({ Name: "pNum", Type: 2, Value: 0 });
      expect(typeof body.Parameters[0].Value).toBe("number");
    });

    it("encodes String as Type 1 and coerces a number default to a string", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pStr", type: "String", defaultValue: 0 },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0]).toEqual({ Name: "pStr", Type: 1, Value: "0" });
      expect(typeof body.Parameters[0].Value).toBe("string");
    });

    it("falls back to 0 for a Numeric default that is not a finite number", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pNum", type: "Numeric", defaultValue: "abc" },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0].Value).toBe(0);
    });

    it("includes Prompt only when present", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pNum", type: "Numeric", defaultValue: 1, prompt: "Year" },
        { name: "pStr", type: "String", defaultValue: "" },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0].Prompt).toBe("Year");
      expect(body.Parameters[1]).not.toHaveProperty("Prompt");
    });
  });

  describe("Code ($value blob transport)", () => {
    it("getCodeBlob GETs Code/$value and returns raw text", async () => {
      const blob = "#region Prolog\r\nsX=1;\r\n#endregion";
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue(blob),
        json: vi.fn().mockRejectedValue(new Error("not json")),
      });

      const result = await client.processes.getCodeBlob("My.Proc");

      expect(result).toBe(blob);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/Processes('My.Proc')/Code/$value");
    });

    it("updateCodeBlob PATCHes { Code } to the process entity", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());
      const blob = "#region Prolog\r\nsX=1;\r\n#endregion";

      await client.processes.updateCodeBlob("My.Proc", blob);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/Processes('My.Proc')");
      expect((init.method as string).toUpperCase()).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ Code: blob });
    });
  });

  describe("getAllCode() – security access", () => {
    it("selects HasSecurityAccess and maps it onto each row", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "proc.elevated",
              PrologProcedure: "p",
              MetadataProcedure: "m",
              DataProcedure: "d",
              EpilogProcedure: "e",
              HasSecurityAccess: true,
            },
            {
              Name: "proc.normal",
              PrologProcedure: "",
              MetadataProcedure: "",
              DataProcedure: "",
              EpilogProcedure: "",
              HasSecurityAccess: false,
            },
          ],
        }),
      );

      const rows = await client.processes.getAllCode(false);

      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain("HasSecurityAccess");
      expect(rows[0]).toMatchObject({
        name: "proc.elevated",
        hasSecurityAccess: true,
      });
      expect(rows[1]).toMatchObject({
        name: "proc.normal",
        hasSecurityAccess: false,
      });
    });

    it("defaults missing HasSecurityAccess to false", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "proc.legacy",
              PrologProcedure: "",
              MetadataProcedure: "",
              DataProcedure: "",
              EpilogProcedure: "",
            },
          ],
        }),
      );
      const rows = await client.processes.getAllCode(false);
      expect(rows[0].hasSecurityAccess).toBe(false);
    });

    it("pushes $top/$orderby/$count server-side and returns items+total when top is set", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          "@odata.count": 7,
          value: [
            {
              Name: "proc.a",
              PrologProcedure: "p",
              MetadataProcedure: "",
              DataProcedure: "",
              EpilogProcedure: "",
            },
          ],
        }),
      );

      const result = await client.processes.getAllCode(false, 1);

      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain("$top=1");
      expect(url).toContain("$orderby=Name");
      expect(url).toContain("$count=true");
      expect(url).toContain("startswith(Name");
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(7);
    });

    it("returns undefined total when @odata.count is absent (caller decides honesty)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "proc.a",
              PrologProcedure: "",
              MetadataProcedure: "",
              DataProcedure: "",
              EpilogProcedure: "",
            },
          ],
        }),
      );
      const result = await client.processes.getAllCode(false, 5);
      expect(result.total).toBeUndefined();
    });
  });
});
