import { afterEach, describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { RestBody } from "../../src/tm1-client/services/rest-service.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { registerRestRead } from "../../src/tools/rest/rest-read.js";
import { registerRestWrite } from "../../src/tools/rest/rest-write.js";
import { dataBudget, responseLimit } from "../../src/tools/rest/shape.js";
import type { ToolRegistrar } from "../../src/tools/define-tool.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { mockLogger } from "../helpers/client-harness.js";

// The REST tools cut their own payload so the response guard never has to
// refuse it. That only works if the cut honours the CONFIGURED limit
// (TM1_MAX_RESPONSE_CHARS), not the 80k default.

type Result = { isError?: boolean; content: Array<{ text: string }> };

// Register through the real response guard, with the same limit in the
// guard and in the env, as src/index.ts wires it.
function wire(register: ToolRegistrar, limit: number, body: RestBody) {
  vi.stubEnv("TM1_MAX_RESPONSE_CHARS", String(limit));
  const client = {
    version: 11,
    connectionId: "fake:1",
    rest: { get: async () => body, send: async () => body },
  } as unknown as TM1Client;
  const server = new McpServer({ name: "t", version: "0.0.0" });
  let cb: ((args: unknown, extra: unknown) => Promise<Result>) | undefined;
  server.registerTool = ((...args: unknown[]) => {
    cb = args[2] as typeof cb;
    return {} as ReturnType<typeof server.registerTool>;
  }) as typeof server.registerTool;
  register(
    withAnnotations(server, mockLogger, "readwrite", "legacy", limit),
    ConnectionRegistry.of([{ name: "default", client, mode: "readwrite" }]),
  );
  return (args: Record<string, unknown>) => cb!(args, {});
}

// ~25k characters of elements once serialized: under the 30k default
// maxChars, so shapeBody alone would keep it all.
const elements = (): RestBody => ({
  kind: "json",
  json: {
    value: Array.from({ length: 400 }, (_, i) => ({
      Name: `Element ${String(i).padStart(4, "0")} ${"x".repeat(20)}`,
      Type: "Numeric",
    })),
  },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("REST tools honour TM1_MAX_RESPONSE_CHARS", () => {
  it("uses a fixture between the lowered limit and the default budget", () => {
    const chars = JSON.stringify((elements() as { json: unknown }).json).length;
    expect(chars).toBeGreaterThan(20_000);
    expect(chars).toBeLessThan(30_000);
  });

  it("tm1_rest_read trims to a lowered limit instead of being refused", async () => {
    const res = await wire(
      registerRestRead,
      20_000,
      elements(),
    )({
      connection: "default",
      path: "Dimensions('D')/Hierarchies('D')/Elements",
      maxChars: 30_000,
    });
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(400);
    expect(res.content[0].text.length).toBeLessThanOrEqual(20_000);
  });

  it("tm1_rest_write trims its echo to a lowered limit", async () => {
    const res = await wire(
      registerRestWrite,
      10_000,
      elements(),
    )({
      connection: "default",
      method: "POST",
      path: "Dimensions('D')/Hierarchies('D')/Elements",
      body: { Name: "E" },
    });
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(out).toMatchObject({ success: true, truncated: true });
    expect(res.content[0].text.length).toBeLessThanOrEqual(10_000);
  });
});

describe("dataBudget / responseLimit", () => {
  it("caps the requested budget at the limit minus the envelope", () => {
    expect(dataBudget(30_000, 500, 20_000)).toBe(19_500);
    expect(dataBudget(5_000, 500, 20_000)).toBe(5_000);
    expect(dataBudget(5_000, 500, 100)).toBe(1);
  });

  it("reads TM1_MAX_RESPONSE_CHARS, falling back to the default", () => {
    expect(responseLimit({ TM1_MAX_RESPONSE_CHARS: "12345" })).toBe(12_345);
    expect(responseLimit({})).toBe(80_000);
  });
});
