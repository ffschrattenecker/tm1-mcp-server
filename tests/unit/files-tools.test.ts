// tm1_files_read / tm1_files_write replace the five single-purpose file tools.
// The base64 cases use bytes that are NOT valid UTF-8 on purpose: a UTF-8
// decode replaces every invalid byte with U+FFFD, and that loss is silent — a
// fixture like Buffer.from("payload") would pass either way.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodObject, type ZodRawShape } from "zod";
import { registerFilesRead } from "../../src/tools/fileops/files-read.js";
import { registerFilesWrite } from "../../src/tools/fileops/files-write.js";
import { specFor, type ToolRegistrar } from "../../src/tools/define-tool.js";
import { strictVariants } from "../../src/tools/schemas/markdown-capable.js";
import type { TM1Client } from "../../src/tm1-client.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

// 0x80 is a continuation byte with nothing to continue: invalid UTF-8.
const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0xff, 0x00, 0xfe]);

function fakeFiles(bytes: Buffer = BINARY) {
  return {
    list: vi.fn(async () => ["a.csv", "b.csv", "c.txt"]),
    search: vi.fn(async () => ["sales_1.csv"]),
    getContentBytes: vi.fn(async () => bytes),
    upload: vi.fn(async () => ({ created: true, root: "Files" as const })),
    delete: vi.fn(async () => undefined),
  };
}

function setup(register: ToolRegistrar, files = fakeFiles()) {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      _name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      parser = z.object(schema);
      captured = handler;
    },
  };
  register(
    server as unknown as Parameters<typeof register>[0],
    { files } as unknown as TM1Client,
  );
  // Read back through explicit types: TS narrows the closure variables to
  // `never` because it cannot see that register* called `tool` synchronously.
  const h = captured as ToolHandler | null;
  const p = parser as z.ZodObject<ZodRawShape> | null;
  if (!h || !p) throw new Error("handler not registered");
  const call: ToolHandler = (args) => h(p.parse(args));
  return { call, files, parser: p };
}

const json = (res: ToolResult) =>
  JSON.parse(res.content[0].text) as Record<string, unknown>;

interface FileContent {
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
  truncationReason?: string;
  content: string;
}
const asFileContent = (payload: Record<string, unknown>) =>
  payload as unknown as FileContent;

// The harness bypasses the Proxy, so check payloads against the strict JSON
// variant the Proxy would pick, with .strict() standing in for the client's
// additionalProperties:false.
function readSchema(): ZodObject<ZodRawShape> {
  const spec = specFor("tm1_files_read");
  expect(spec?.outputSchema).toBeDefined();
  const variants = strictVariants(spec!.outputSchema);
  expect(variants).toBeDefined();
  return (variants!.json as ZodObject<ZodRawShape>).strict();
}

function expectConforms(payload: unknown) {
  const result = readSchema().safeParse(payload);
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
}

describe("tm1_files_read op=list", () => {
  it("lists the folder, echoes path and pages the names", async () => {
    const { call, files } = setup(registerFilesRead);
    const res = await call({ op: "list", path: "imports", limit: 2 });
    expect(files.list).toHaveBeenCalledWith("imports", "files");
    const out = json(res);
    expect(out).toMatchObject({
      path: "imports",
      total: 3,
      count: 2,
      has_more: true,
      next_offset: 2,
      items: ["a.csv", "b.csv"],
    });
    expectConforms(out);
  });

  it("passes container='applications' through and defaults path to root", async () => {
    const { call, files } = setup(registerFilesRead);
    const out = json(await call({ op: "list", container: "applications" }));
    expect(files.list).toHaveBeenCalledWith(undefined, "applications");
    expect(out.path).toBe("");
  });

  it("renders a markdown table when format='markdown'", async () => {
    const { call } = setup(registerFilesRead);
    const res = await call({ op: "list", format: "markdown" });
    expect(res.structuredContent).toHaveProperty("markdown");
    expect(res.content[0].text).toContain("a.csv");
  });
});

describe("tm1_files_read op=search", () => {
  it("forwards the filters and echoes them next to the page", async () => {
    const { call, files } = setup(registerFilesRead);
    const out = json(
      await call({
        op: "search",
        startswith: "sales_",
        contains: ["1", "csv"],
        operator: "or",
      }),
    );
    expect(files.search).toHaveBeenCalledWith({
      startswith: "sales_",
      contains: ["1", "csv"],
      operator: "or",
      path: undefined,
      container: "files",
    });
    expect(out).toMatchObject({
      path: "",
      startswith: "sales_",
      contains: ["1", "csv"],
      operator: "or",
      items: ["sales_1.csv"],
    });
    expectConforms(out);
  });

  it("echoes null for absent filters and operator 'and' by default", async () => {
    const { call } = setup(registerFilesRead);
    const out = json(await call({ op: "search" }));
    expect(out).toMatchObject({
      startswith: null,
      contains: null,
      operator: "and",
    });
  });
});

describe("tm1_files_read op=get, base64 encoding", () => {
  it("returns bytes that are not valid UTF-8 unchanged", async () => {
    const { call } = setup(registerFilesRead);
    const res = await call({
      op: "get",
      fileName: "book.xlsx",
      encoding: "base64",
    });
    const out = asFileContent(json(res));
    expect(Buffer.from(out.content, "base64")).toEqual(BINARY);
    expect(out.totalBytes).toBe(BINARY.byteLength);
    expect(out.returnedBytes).toBe(BINARY.byteLength);
    expect(out.truncated).toBe(false);
    expectConforms(out);
  });

  it("truncates to maxBytes and counts the bytes, not the base64 characters", async () => {
    const { call } = setup(registerFilesRead);
    const out = asFileContent(
      json(
        await call({
          op: "get",
          fileName: "book.xlsx",
          encoding: "base64",
          maxBytes: 4,
        }),
      ),
    );
    expect(Buffer.from(out.content, "base64")).toEqual(BINARY.subarray(0, 4));
    expect(out.returnedBytes).toBe(4);
    expect(out.totalBytes).toBe(BINARY.byteLength);
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("maxBytes=4");
  });

  it("defaults to a slice whose base64 fits the 80k response limit", async () => {
    const big = Buffer.alloc(64 * 1024, 0xff);
    const { call } = setup(registerFilesRead, fakeFiles(big));
    const res = await call({
      op: "get",
      fileName: "book.xlsx",
      encoding: "base64",
    });
    const out = asFileContent(json(res));
    expect(out.returnedBytes).toBe(48 * 1024);
    expect(out.truncated).toBe(true);
    expect(res.content[0].text.length).toBeLessThan(80_000);
  });

  it("shows what a text read costs on the same bytes", async () => {
    const { call } = setup(registerFilesRead);
    const out = asFileContent(
      json(await call({ op: "get", fileName: "book.xlsx" })),
    );
    expect(out.content).toContain("�");
  });
});

describe("tm1_files_read op=get, text encoding", () => {
  const TEXT = Buffer.from("h1\nr1\nr2\nr3", "utf8");

  it("defaults to 64 KB for text", async () => {
    const big = Buffer.alloc(70 * 1024, 0x61);
    const { call } = setup(registerFilesRead, fakeFiles(big));
    const out = json(await call({ op: "get", fileName: "a.csv" }));
    expect(out).toMatchObject({
      returnedBytes: 64 * 1024,
      truncated: true,
      truncationReason: `maxBytes=${64 * 1024}`,
      encoding: "text",
    });
  });

  it("headLines overrides byte truncation and reports the line count", async () => {
    const { call, files } = setup(registerFilesRead, fakeFiles(TEXT));
    const out = json(
      await call({
        op: "get",
        fileName: "a.csv",
        headLines: 2,
        container: "applications",
      }),
    );
    expect(files.getContentBytes).toHaveBeenCalledWith("a.csv", "applications");
    expect(out).toMatchObject({
      content: "h1\nr1",
      truncated: true,
      truncationReason: "headLines=2 (of 4)",
    });
    expectConforms(out);
  });

  it("returns the whole file untruncated when it fits", async () => {
    const { call } = setup(registerFilesRead, fakeFiles(TEXT));
    const out = json(await call({ op: "get", fileName: "a.csv" }));
    expect(out.content).toBe(TEXT.toString("utf8"));
    expect(out.truncated).toBe(false);
    expect(out).not.toHaveProperty("truncationReason");
  });

  it("rejects maxBytes above the 4 MB hard max at parse time", () => {
    const { parser } = setup(registerFilesRead);
    expect(
      parser.safeParse({
        op: "get",
        fileName: "a.csv",
        maxBytes: 4 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });
});

describe("tm1_files_read, wrong field combinations", () => {
  it.each([
    [{ op: "get" }, /needs fileName/],
    [{ op: "list", fileName: "a.csv" }, /fileName does not apply to op="list"/],
    [{ op: "list", startswith: "x" }, /startswith does not apply/],
    [{ op: "search", headLines: 3 }, /headLines does not apply/],
    [{ op: "get", fileName: "a.csv", path: "x" }, /path does not apply/],
    [
      { op: "get", fileName: "a.csv", format: "markdown" },
      /format="markdown" applies to/,
    ],
  ])("%j -> VALIDATION_ERROR", async (args, message) => {
    const { call, files } = setup(registerFilesRead);
    await expect(call(args)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(message),
    });
    expect(files.list).not.toHaveBeenCalled();
    expect(files.search).not.toHaveBeenCalled();
    expect(files.getContentBytes).not.toHaveBeenCalled();
  });
});

describe("tm1_files_write op=upload", () => {
  it("uploads text content and reports created/updated/container", async () => {
    const { call, files } = setup(registerFilesWrite);
    const res = await call({
      op: "upload",
      fileName: "imports/a.csv",
      content: "x,y",
      confirm: "imports/a.csv",
    });
    expect(files.upload).toHaveBeenCalledWith(
      "imports/a.csv",
      Buffer.from("x,y", "utf8"),
      "files",
    );
    expect(res.structuredContent).toEqual({
      success: true,
      fileName: "imports/a.csv",
      bytesUploaded: 3,
      created: true,
      updated: false,
      container: "Files",
    });
  });

  it("decodes base64 content to the original bytes", async () => {
    const { call, files } = setup(registerFilesWrite);
    await call({
      op: "upload",
      fileName: "book.xlsx",
      content: BINARY.toString("base64"),
      encoding: "base64",
      container: "applications",
      confirm: "book.xlsx",
    });
    expect(files.upload).toHaveBeenCalledWith(
      "book.xlsx",
      BINARY,
      "applications",
    );
  });

  it("refuses without a matching confirm and writes nothing", async () => {
    const { call, files } = setup(registerFilesWrite);
    await expect(
      call({ op: "upload", fileName: "a.csv", content: "x", confirm: "b.csv" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(files.upload).not.toHaveBeenCalled();
  });

  it("refuses a missing content", async () => {
    const { call, files } = setup(registerFilesWrite);
    await expect(
      call({ op: "upload", fileName: "a.csv", confirm: "a.csv" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/needs content/),
    });
    expect(files.upload).not.toHaveBeenCalled();
  });

  it("returns an isError VALIDATION_ERROR above the 32 MB hard max", async () => {
    const { call, files } = setup(registerFilesWrite);
    const res = await call({
      op: "upload",
      fileName: "big.bin",
      content: "a".repeat(32 * 1024 * 1024 + 1),
      confirm: "big.bin",
    });
    expect(res.isError).toBe(true);
    expect(json(res)).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(files.upload).not.toHaveBeenCalled();
  });
});

describe("tm1_files_write op=delete", () => {
  it("deletes with a matching confirm", async () => {
    const { call, files } = setup(registerFilesWrite);
    const res = await call({
      op: "delete",
      fileName: "old.csv",
      confirm: "old.csv",
    });
    expect(files.delete).toHaveBeenCalledWith("old.csv", "files");
    expect(res.structuredContent).toEqual({
      success: true,
      fileName: "old.csv",
      deleted: true,
    });
  });

  it("refuses a missing confirm at parse time and a mismatch at run time", async () => {
    const { call, files, parser } = setup(registerFilesWrite);
    expect(parser.safeParse({ op: "delete", fileName: "a" }).success).toBe(
      false,
    );
    await expect(
      call({ op: "delete", fileName: "a.csv", confirm: "A.csv" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(files.delete).not.toHaveBeenCalled();
  });

  it("refuses content on delete", async () => {
    const { call, files } = setup(registerFilesWrite);
    await expect(
      call({ op: "delete", fileName: "a", content: "x", confirm: "a" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/content does not apply/),
    });
    expect(files.delete).not.toHaveBeenCalled();
  });

  it("points a service error at tm1_files_read", async () => {
    const files = fakeFiles();
    files.delete.mockRejectedValueOnce(new Error("404"));
    const { call } = setup(registerFilesWrite, files);
    await expect(
      call({ op: "delete", fileName: "a", confirm: "a" }),
    ).rejects.toMatchObject({
      hintOverride: expect.stringContaining("tm1_files_read"),
    });
  });
});

describe("annotations", () => {
  it("files_read is read-only, files_write destructive", () => {
    expect(specFor("tm1_files_read")?.annotations.readOnlyHint).toBe(true);
    const write = specFor("tm1_files_write")?.annotations;
    expect(write?.readOnlyHint).toBe(false);
    expect(write?.destructiveHint).toBe(true);
  });
});
