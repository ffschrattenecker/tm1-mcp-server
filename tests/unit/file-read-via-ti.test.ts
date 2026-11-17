// tm1_read_server_file reads a file TI wrote, which v11 Blobs cannot list. The
// read runs an unbound TI process that copies the source into the logging
// directory, where ErrorLogFiles serves it byte for byte. These tests pin the
// process body (the path must stay in the JSON data source, never in TI code),
// the copy's lifecycle (always deleted, even on failure), and the decode and
// cut rules of the result.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { FileService } from "../../src/tm1-client/services/file-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { specFor } from "../../src/tools/define-tool.js";
import { registerReadServerFile } from "../../src/tools/fileops/read-server-file.js";
import type { TM1Client } from "../../src/tm1-client.js";

const OK = { ProcessExecuteStatusCode: "CompletedSuccessfully" };
const COPY_NAME = /TM1ProcessError_mcpread_[0-9a-f-]+\.log/;

interface Stub {
  /** Response of POST ExecuteProcessWithReturn. */
  run?: unknown;
  /** Bytes of the copy, or undefined when TI wrote none (empty source). */
  copy?: Buffer | undefined;
  /** Text of the process's own error log, when the run failed. */
  log?: string;
}

// Scripted TM1HttpClient: records every call and answers the read's requests.
function makeService(stub: Stub) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const notFound = () =>
    new TM1Error({ code: TM1ErrorCode.NOT_FOUND, message: "not found" });
  const http = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST") return stub.run ?? OK;
      return undefined;
    }),
    requestRaw: vi.fn(async (method: string, path: string) => {
      calls.push({ method, path });
      return stub.log ?? "";
    }),
    requestRawBytes: vi.fn(async (method: string, path: string) => {
      calls.push({ method, path });
      if (stub.copy === undefined) throw notFound();
      return stub.copy;
    }),
  } as unknown as TM1HttpClient;
  return { svc: new FileService(http), calls };
}

interface ProcessBody {
  PrologProcedure: string;
  DataProcedure: string;
  DataSource: { dataSourceNameForServer: string; asciiQuoteCharacter: string };
}
const bodyOf = (calls: Array<{ body?: unknown }>): ProcessBody =>
  (calls[0].body as { Process: ProcessBody }).Process;

describe("FileService.readViaTi", () => {
  it("copies the file through TI, returns its lines and deletes the copy", async () => {
    const { svc, calls } = makeService({
      copy: Buffer.from('Konto;Wert\r\n"K100;1500,00"\r\nä€\r\n', "utf8"),
    });

    const r = await svc.readViaTi("C:\\data\\export.csv", 1000);

    expect(r).toEqual({
      lines: ["Konto;Wert", '"K100;1500,00"', "ä€"],
      truncated: false,
      encoding: "utf-8",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe(
      "/api/v1/ExecuteProcessWithReturn?$expand=ErrorLogFile",
    );
    const p = bodyOf(calls);
    expect(p.DataSource.dataSourceNameForServer).toBe("C:\\data\\export.csv");
    expect(p.DataSource.asciiQuoteCharacter).toBe("");
    // The path reaches the JSON data source only, never the TI code.
    expect(p.PrologProcedure + p.DataProcedure).not.toContain("export.csv");
    expect(p.DataProcedure).toContain("IF(n > 1001);");
    const copy = COPY_NAME.exec(p.PrologProcedure)![0];
    expect(calls[1].path).toContain(`ErrorLogFiles('${copy}')/Content`);
    expect(calls[2]).toMatchObject({ method: "DELETE" });
    expect(calls[2].path).toContain(`ErrorLogFiles('${copy}')`);
  });

  it("returns no lines for an empty source, which leaves no copy to delete", async () => {
    const { svc, calls } = makeService({ copy: undefined });
    expect(await svc.readViaTi("empty.csv", 10)).toEqual({
      lines: [],
      truncated: false,
      encoding: "utf-8",
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("cuts at maxLines and says so", async () => {
    const { svc } = makeService({ copy: Buffer.from("a\r\nb\r\nc\r\n") });
    const r = await svc.readViaTi("x.csv", 2);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.truncated).toBe(true);
  });

  it("does not report truncation when the file holds exactly maxLines", async () => {
    const { svc } = makeService({ copy: Buffer.from("a\r\nb\r\n") });
    const r = await svc.readViaTi("x.csv", 2);
    expect(r).toMatchObject({ lines: ["a", "b"], truncated: false });
  });

  it("decodes an ANSI file as windows-1252", async () => {
    const { svc } = makeService({
      copy: Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x80, 13, 10]),
    });
    const r = await svc.readViaTi("ansi.csv", 10);
    expect(r.lines).toEqual(["Müller€"]);
    expect(r.encoding).toBe("windows-1252");
  });

  it("raises NOT_FOUND with the server log, and deletes the log and the copy", async () => {
    const { svc, calls } = makeService({
      run: {
        ProcessExecuteStatusCode: "Aborted",
        ErrorLogFile: { Filename: "c.log" },
      },
      log: "Error: Prolog procedure line (0): Unable to open data source",
      copy: undefined,
    });
    const err = await svc.readViaTi("missing.csv", 10).catch((e) => e);
    expect(err).toBeInstanceOf(TM1Error);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    expect(err.details).toContain("Unable to open data source");
    // The process's own error log of this throwaway run goes first ...
    expect(calls[2].path).toContain("ErrorLogFiles('c.log')");
    expect(calls[2].method).toBe("DELETE");
    // ... then the copy, which may be partial, is removed as well.
    expect(calls[3].path).toContain("TM1ProcessError_mcpread_");
    expect(calls[3].method).toBe("DELETE");
  });

  it("removes the copy when reading it fails for another reason", async () => {
    const http = {
      request: vi.fn(async (method: string) =>
        method === "POST" ? OK : undefined,
      ),
      requestRaw: vi.fn(),
      requestRawBytes: vi.fn(async () => {
        throw new TM1Error({
          code: TM1ErrorCode.CONNECTION_FAILED,
          message: "down",
        });
      }),
    } as unknown as TM1HttpClient;
    const svc = new FileService(http);
    await expect(svc.readViaTi("x.csv", 10)).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
    const deletes = (
      http.request as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[0] === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toMatch(COPY_NAME);
  });
});

describe("tm1_read_server_file tool", () => {
  type Handler = (args: Record<string, unknown>) => Promise<unknown>;

  function register(readViaTi: ReturnType<typeof vi.fn>) {
    let captured: Handler | null = null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    const server = {
      tool: (
        _name: string,
        _desc: string,
        schema: ZodRawShape,
        handler: Handler,
      ) => {
        parser = z.object(schema);
        captured = handler;
      },
    };
    registerReadServerFile(
      server as unknown as Parameters<typeof registerReadServerFile>[0],
      { version: 11, files: { readViaTi } } as unknown as TM1Client,
    );
    const h = captured as Handler | null;
    const p = parser as z.ZodObject<ZodRawShape> | null;
    if (!h || !p) throw new Error("handler not registered");
    return (args: Record<string, unknown>) => h(p.parse(args));
  }

  it("is not READ_ONLY, so readonly connections refuse it: it runs TI", () => {
    const annot = specFor("tm1_read_server_file")?.annotations;
    expect(annot?.readOnlyHint).toBeFalsy();
    expect(annot?.destructiveHint).toBe(true);
    expect(annot?.requiresVersion).toBe("v11");
  });

  it("is not registered on a v12-only server", () => {
    const names: string[] = [];
    const server = { tool: (name: string) => void names.push(name) };
    registerReadServerFile(
      server as unknown as Parameters<typeof registerReadServerFile>[0],
      { version: 12, files: {} } as unknown as TM1Client,
    );
    expect(names).toEqual([]);
  });

  it("defaults maxLines to 1000 and returns the payload as JSON", async () => {
    const readViaTi = vi.fn(async () => ({
      lines: ["a", "b"],
      truncated: false,
      encoding: "utf-8" as const,
    }));
    const call = register(readViaTi);
    const res = (await call({ path: "x.csv" })) as {
      content: Array<{ text: string }>;
    };
    expect(readViaTi).toHaveBeenCalledWith("x.csv", 1000);
    const out = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(out).toEqual({
      path: "x.csv",
      lineCount: 2,
      truncated: false,
      encoding: "utf-8",
      lines: ["a", "b"],
    });
    // Published as a raw shape; .strict() stands in for additionalProperties:false.
    const shape = specFor("tm1_read_server_file")!.outputSchema as ZodRawShape;
    const schema = z.object(shape).strict();
    expect(schema.safeParse(out).success).toBe(true);
  });

  it("rejects maxLines above the hard cap before any TI run", () => {
    const call = register(vi.fn());
    expect(() => call({ path: "x.csv", maxLines: 20001 })).toThrow();
  });
});
