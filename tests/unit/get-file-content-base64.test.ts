// encoding='base64' exists so an Applications spreadsheet survives the trip:
// a UTF-8 decode replaces every invalid byte with U+FFFD, and that loss is
// silent. These tests use bytes that are NOT valid UTF-8 on purpose — a
// fixture like Buffer.from("payload") would pass either way.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerGetFileContent } from "../../src/tools/fileops/get-file-content.js";
import { FileContentResultSchema } from "../../src/tools/schemas/items.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

// 0x80 is a continuation byte with nothing to continue: invalid UTF-8.
const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0xff, 0x00, 0xfe]);

function handlerFor(bytes: Buffer): ToolHandler {
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
  const client = {
    files: { getContentBytes: vi.fn(async () => bytes) },
  } as unknown as TM1Client;
  registerGetFileContent(
    server as unknown as Parameters<typeof registerGetFileContent>[0],
    client,
  );
  // Read back through explicit types: TS narrows the closure variables to
  // `never` because it cannot see that register* called `tool` synchronously.
  const h = captured as ToolHandler | null;
  const p = parser as z.ZodObject<ZodRawShape> | null;
  if (!h || !p) throw new Error("handler not registered");
  return (args) => h(p.parse(args));
}

async function payload(args: Record<string, unknown>, bytes = BINARY) {
  const res = await handlerFor(bytes)(args);
  // The SDK rejects a payload the declared output schema does not accept, so
  // the shape is asserted here rather than only the values.
  return FileContentResultSchema.parse(JSON.parse(res.content[0].text));
}

describe("tm1_get_file_content, base64 encoding", () => {
  it("returns bytes that are not valid UTF-8 unchanged", async () => {
    const out = await payload({ fileName: "book.xlsx", encoding: "base64" });
    expect(Buffer.from(out.content, "base64")).toEqual(BINARY);
    expect(out.totalBytes).toBe(BINARY.byteLength);
    expect(out.returnedBytes).toBe(BINARY.byteLength);
    expect(out.truncated).toBe(false);
  });

  it("truncates to maxBytes and counts the bytes, not the base64 characters", async () => {
    const out = await payload({
      fileName: "book.xlsx",
      encoding: "base64",
      maxBytes: 4,
    });
    expect(Buffer.from(out.content, "base64")).toEqual(BINARY.subarray(0, 4));
    expect(out.returnedBytes).toBe(4);
    expect(out.totalBytes).toBe(BINARY.byteLength);
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe("maxBytes=4");
  });

  it("defaults to a slice whose base64 fits the 80k response limit", async () => {
    const big = Buffer.alloc(64 * 1024, 0xff);
    const res = await handlerFor(big)({
      fileName: "book.xlsx",
      encoding: "base64",
    });
    const out = FileContentResultSchema.parse(JSON.parse(res.content[0].text));
    expect(out.returnedBytes).toBe(48 * 1024);
    expect(out.truncated).toBe(true);
    expect(res.content[0].text.length).toBeLessThan(80_000);
  });

  it("shows what a text read costs on the same bytes", async () => {
    const out = await payload({ fileName: "book.xlsx" });
    expect(out.content).toContain("�");
  });
});
