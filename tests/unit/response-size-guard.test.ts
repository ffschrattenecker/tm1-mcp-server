import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { defineTool } from "../../src/tools/define-tool.js";
import { READ_ONLY } from "../../src/tools/annotations.js";
import {
  narrowingHint,
  withAnnotations,
} from "../../src/tools/with-annotations.js";
import { PAGINATION_SCHEMA } from "../../src/tools/pagination.js";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
};

// A paged tool whose payload size the test controls through `limit`.
const register = defineTool({
  name: "tm1_spec_size_guard",
  description: "fixture",
  annotations: READ_ONLY,
  output: z.object({ items: z.array(z.string()) }),
  input: { ...PAGINATION_SCHEMA },
  handler: async ({ limit }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ items: Array(limit).fill("x".repeat(98)) }),
      },
    ],
  }),
});

function wire(
  maxChars: number,
  responseMode: "legacy" | "structured" = "legacy",
) {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  let cb: ((args: unknown, extra: unknown) => Promise<Result>) | undefined;
  server.registerTool = ((...args: unknown[]) => {
    cb = args[2] as typeof cb;
    return {} as ReturnType<typeof server.registerTool>;
  }) as typeof server.registerTool;
  register(
    withAnnotations(server, mockLogger, "readwrite", responseMode, maxChars),
    {} as TM1Client,
  );
  return (limit: number) => cb!({ limit, offset: 0, fetchAll: false }, {});
}

describe("response size guard", () => {
  it("passes a result under the limit through unchanged", async () => {
    const res = await wire(10_000)(10);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      items: Array(10).fill("x".repeat(98)),
    });
  });

  it("replaces an oversized result with RESPONSE_TOO_LARGE, never a truncated payload", async () => {
    const res = await wire(1_000)(50);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const err = JSON.parse(res.content[0].text) as {
      code: string;
      message: string;
      hint: string;
      details: string;
    };
    expect(err.code).toBe("RESPONSE_TOO_LARGE");
    expect(err.message).toContain("over the 1000-character response limit");
    expect(err.hint).toContain("smaller limit");
    expect(JSON.parse(err.details)).toMatchObject({ limit: 1000 });
  });

  it("measures structuredContent when structured mode emptied content[]", async () => {
    const res = await wire(1_000, "structured")(50);
    expect(res.isError).toBe(true);
  });
});

describe("narrowingHint", () => {
  it("derives the advice from the tool's input keys", () => {
    expect(narrowingHint(new Set(["outline", "lineRange"]))).toContain(
      "outline=true",
    );
    expect(narrowingHint(new Set(["topN", "countOnly"]))).toMatch(
      /countOnly=true.*smaller topN/,
    );
    expect(narrowingHint(new Set(["maxBytes"]))).toContain("smaller maxBytes");
    expect(narrowingHint(new Set())).toContain("Narrow the request");
  });
});
