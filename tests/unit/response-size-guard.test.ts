import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../src/tm1-client.js";
import { defineTool } from "../../src/tools/define-tool.js";
import { READ_ONLY } from "../../src/tools/annotations.js";
import {
  narrowingHint,
  trimPageToFit,
  withAnnotations,
} from "../../src/tools/with-annotations.js";
import { PAGINATION_SCHEMA } from "../../src/tools/pagination.js";
import { mockLogger } from "../helpers/client-harness.js";

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

describe("trimPageToFit", () => {
  const page = (n: number) => ({
    total: 200,
    count: n,
    offset: 20,
    has_more: true,
    next_offset: 20 + n,
    items: Array.from({ length: n }, (_, i) => ({
      name: `item-${i}`.padEnd(90, "."),
    })),
  });
  const asResult = (payload: unknown, withText = true) => ({
    content: withText
      ? [{ type: "text" as const, text: JSON.stringify(payload) }]
      : [],
    structuredContent: payload as { [k: string]: unknown },
  });

  it("cuts an oversized page to the longest prefix that fits and points at the rest", () => {
    const trimmed = trimPageToFit(asResult(page(50)), 2_000);
    const out = trimmed?.structuredContent as ReturnType<typeof page>;

    expect(out.count).toBeGreaterThan(0);
    expect(out.count).toBeLessThan(50);
    expect(out.items).toHaveLength(out.count);
    expect(out.items[0]).toEqual(page(50).items[0]);
    expect(out.next_offset).toBe(20 + out.count);
    expect(out.has_more).toBe(true);
    expect(out.total).toBe(200);
    // The text block mirrors the structured payload and fits the limit.
    const text = trimmed!.content[0].text;
    expect(JSON.parse(text)).toEqual(out);
    expect(text.length).toBeLessThanOrEqual(2_000);
    // One more item would not have fit.
    const n = out.count + 1;
    const oneMore = {
      ...out,
      count: n,
      next_offset: 20 + n,
      items: page(50).items.slice(0, n),
    };
    expect(JSON.stringify(oneMore).length).toBeGreaterThan(2_000);
  });

  it("works without a text block (structured response mode)", () => {
    const trimmed = trimPageToFit(asResult(page(50), false), 2_000);
    expect(trimmed?.content).toEqual([]);
    expect(
      JSON.stringify(trimmed?.structuredContent).length,
    ).toBeLessThanOrEqual(2_000);
  });

  it("gives up when not even one item fits, or the payload is not a page", () => {
    expect(trimPageToFit(asResult(page(5)), 50)).toBeUndefined();
    expect(trimPageToFit(asResult({ markdown: "| a |" }), 5)).toBeUndefined();
  });
});
