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

    it.each([
      ["no params", undefined],
      ["an empty object", {}],
    ])("sends no Parameters when given %s", async (_label, params) => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("SimpleProcess", params);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toBeUndefined();
    });

    it.each([
      ["400", 400, "Process aborted with error in Prolog"],
      ["404", 404, "Process 'BrokenProcess' not found"],
    ])(
      "returns failure when TM1 answers HTTP %s",
      async (_status, status, message) => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse({ error: { message } }, status),
        );

        const result = await client.processes.execute("BrokenProcess");

        expect(result.success).toBe(false);
        expect(result.processErrorStatus).toContain(message);
      },
    );

    it("encodes special characters in the process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("My Process");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Processes('My%20Process')");
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
    it("maps parameter types and omits prompt when the API has none", async () => {
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
      expect(params[1]).not.toHaveProperty("prompt");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportData')/Parameters");
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
  });

  // ── createProcess() ──────────────────────────────────────────────────────

  describe("create()", () => {
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
  });

  // ── getProcessDataSource() ───────────────────────────────────────────────

  describe("getDataSource()", () => {
    it.each([
      ["None", { Type: "None" }, { type: "None" }],
      [
        "ASCII",
        {
          Type: "ASCII",
          dataSourceNameForServer: "/data/input.csv",
          dataSourceNameForClient: "C:\\data\\input.csv",
          asciiDelimiterChar: ",",
          asciiQuoteCharacter: '"',
          asciiHeaderRecords: 1,
        },
        {
          type: "ASCII",
          dataSourceNameForServer: "/data/input.csv",
          dataSourceNameForClient: "C:\\data\\input.csv",
          asciiDelimiterChar: ",",
          asciiQuoteCharacter: '"',
          asciiHeaderRecords: 1,
        },
      ],
      [
        "ODBC",
        {
          Type: "ODBC",
          dataSourceNameForServer: "MyDB",
          query: "SELECT * FROM table1",
        },
        {
          type: "ODBC",
          dataSourceNameForServer: "MyDB",
          query: "SELECT * FROM table1",
        },
      ],
    ])("maps a %s data source", async (_type, wire, expected) => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ Name: "TestProcess", DataSource: wire }),
      );

      const ds = await client.processes.getDataSource("TestProcess");

      expect(ds).toEqual(expected);
    });
  });

  // ── updateProcessDataSource() ────────────────────────────────────────────

  describe("updateDataSource()", () => {
    it.each([
      [
        "ASCII",
        {
          type: "ASCII",
          dataSourceNameForServer: "/data/new.csv",
          asciiDelimiterChar: ";",
          asciiHeaderRecords: 2,
        },
        {
          Type: "ASCII",
          dataSourceNameForServer: "/data/new.csv",
          asciiDelimiterChar: ";",
          asciiHeaderRecords: 2,
        },
      ],
      ["None", { type: "None" }, { Type: "None" }],
      [
        "ODBC",
        {
          type: "ODBC",
          dataSourceNameForServer: "NewDB",
          query: "SELECT id FROM users",
        },
        {
          Type: "ODBC",
          dataSourceNameForServer: "NewDB",
          query: "SELECT id FROM users",
        },
      ],
    ])("PATCHes the %s DataSource shape", async (_type, input, expected) => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("ImportCSV", input as never);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportCSV')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.DataSource).toEqual(expected);
    });

    // usesUnicode is an ODBC setting, not a version one. 11.8 rejects it for an
    // ASCII source ("unprocessed properties") and accepts it for an ODBC source,
    // where it also drives .pro line 559 — measured on both servers. The old
    // pair of tests asserted the opposite and pinned the bug in place.
    it.each([
      [
        "11.8",
        11,
        { type: "ODBC", dataSourceNameForServer: "DSN", usesUnicode: false },
        false,
      ],
      [
        "12.0",
        12,
        { type: "ODBC", dataSourceNameForServer: "DSN", usesUnicode: false },
        false,
      ],
      [
        "11.8",
        11,
        {
          type: "ASCII",
          dataSourceNameForServer: "/data/x.csv",
          usesUnicode: true,
        },
        undefined,
      ],
      [
        "12.0",
        12,
        {
          type: "ASCII",
          dataSourceNameForServer: "/data/x.csv",
          usesUnicode: true,
        },
        undefined,
      ],
    ])(
      "%s: usesUnicode on the %j source is sent as %s",
      async (tm1Version, version, input, expected) => {
        const cfg = makeTestConfig({
          requestTimeoutMs: 5000,
          version,
          tm1Version,
        } as Partial<TM1Config>);
        const c = stubbedClient(cfg, "sess");
        fetchSpy.mockResolvedValueOnce(mock204Response());

        await c.processes.updateDataSource("ImportODBC", input as never);

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts.body);
        expect(body.DataSource.usesUnicode).toBe(expected);
      },
    );
  });

  // Regression: TM1 v11 ignores the parameter `Type` field and classifies a
  // parameter from the JSON type of `Value`. Encoding must coerce `Value` to
  // the declared `type` (and emit the correct OData enum: String=1, Numeric=2),
  // otherwise a Numeric param whose default arrives as a string is stored as
  // String. Verified against a live PATCH+read roundtrip.
  describe("updateParameters() – parameter encoding", () => {
    it.each([
      [
        "String and Numeric, with Prompt on the String one",
        [
          {
            name: "pFile",
            type: "String",
            defaultValue: "/data/in.csv",
            prompt: "File path",
          },
          { name: "pYear", type: "Numeric", defaultValue: 2024 },
        ],
        [
          {
            Name: "pFile",
            Type: 1,
            Value: "/data/in.csv",
            Prompt: "File path",
          },
          { Name: "pYear", Type: 2, Value: 2024 },
        ],
      ],
      ["an empty list", [], []],
      [
        "Numeric with a string default, coerced to a number",
        [{ name: "pNum", type: "Numeric", defaultValue: "0" }],
        [{ Name: "pNum", Type: 2, Value: 0 }],
      ],
      [
        "String with a number default, coerced to a string",
        [{ name: "pStr", type: "String", defaultValue: 0 }],
        [{ Name: "pStr", Type: 1, Value: "0" }],
      ],
      [
        "Numeric with a non-finite default, falling back to 0",
        [{ name: "pNum", type: "Numeric", defaultValue: "abc" }],
        [{ Name: "pNum", Type: 2, Value: 0 }],
      ],
      [
        "Prompt only where present",
        [
          { name: "pNum", type: "Numeric", defaultValue: 1, prompt: "Year" },
          { name: "pStr", type: "String", defaultValue: "" },
        ],
        [
          { Name: "pNum", Type: 2, Value: 1, Prompt: "Year" },
          { Name: "pStr", Type: 1, Value: "" },
        ],
      ],
    ])("encodes %s", async (_label, params, expected) => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", params as never);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual(expected);
    });
  });

  describe("updateVariables() – reserved names", () => {
    it("names NVALUE/SVALUE/VALUE_IS_STRING instead of sending them", async () => {
      await expect(
        client.processes.updateVariables("Proc", [
          { name: "v1", type: "String", position: 1 },
          { name: "NVALUE", type: "Numeric", position: 0 },
          { name: "VALUE_IS_STRING", type: "Numeric", position: 0 },
        ]),
      ).rejects.toThrow(/NVALUE, VALUE_IS_STRING are reserved/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("lets other casings through, as TM1 does", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());
      await client.processes.updateVariables("Proc", [
        { name: "nvalue", type: "Numeric", position: 1 },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    it("selects HasSecurityAccess, maps it onto each row, and defaults a missing value to false", async () => {
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
      expect(rows[2].hasSecurityAccess).toBe(false);
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
  });
});
