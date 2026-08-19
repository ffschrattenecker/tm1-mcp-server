// defineTool() is the single-site replacement for the name-keyed metadata maps.
// What matters here is what it DERIVES — the two things the maps needed spelled
// out by hand, and which a lint gate used to police:
//   - markdownCapable() from `format` in the input shape
//   - asOutputSchema() routing so a passthrough schema keeps its catchall
// Plus the wiring: a spec must reach the registration Proxy in place of a map
// entry, including the readonly-mode filter.
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { defineTool, specFor } from "../../src/tools/define-tool.js";
import { READ_ONLY, DESTRUCTIVE } from "../../src/tools/annotations.js";
import { strictVariants } from "../../src/tools/schemas/markdown-capable.js";
import { FORMAT_SCHEMA } from "../../src/tools/format.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";

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

const fakeClient = {} as TM1Client;
const ok = () => ({ content: [{ type: "text" as const, text: "{}" }] });

describe("defineTool", () => {
  it("derives markdown capability from `format` in the input shape", () => {
    defineTool({
      name: "tm1_spec_markdown",
      description: "fixture",
      annotations: READ_ONLY,
      output: z.object({ value: z.string() }),
      input: { ...FORMAT_SCHEMA },
      handler: ok,
    });

    const schema = specFor("tm1_spec_markdown")?.outputSchema;
    const variants = strictVariants(schema);
    expect(
      variants,
      "output was not widened by markdownCapable()",
    ).toBeDefined();
    // Widened: a markdown-only payload validates, and so does the full one.
    expect(
      (schema as z.ZodTypeAny).safeParse({ markdown: "| a |" }).success,
    ).toBe(true);
    // The strict JSON variant is kept for the per-response guard.
    expect(variants?.json.safeParse({ value: "x" }).success).toBe(true);
    expect(variants?.json.safeParse({}).success).toBe(false);
  });

  it("leaves the output schema strict when the tool offers no format param", () => {
    defineTool({
      name: "tm1_spec_json_only",
      description: "fixture",
      annotations: READ_ONLY,
      output: z.object({ value: z.string() }),
      input: { cubeName: z.string() },
      handler: ok,
    });

    const schema = specFor("tm1_spec_json_only")?.outputSchema;
    expect(strictVariants(schema as object)).toBeUndefined();
    // Plain object → published as a raw shape, per SDK convention.
    expect(z.object(schema as z.ZodRawShape).safeParse({}).success).toBe(false);
  });

  it("keeps a passthrough schema whole instead of dropping its catchall", () => {
    defineTool({
      name: "tm1_spec_passthrough",
      description: "fixture",
      annotations: READ_ONLY,
      output: z.object({ success: z.boolean() }).passthrough(),
      input: { cubeName: z.string() },
      handler: ok,
    });

    const schema = specFor("tm1_spec_passthrough")
      ?.outputSchema as z.ZodTypeAny;
    // A raw shape would have lost `additionalProperties: true`, and this extra
    // key would fail to parse.
    expect(schema.safeParse({ success: true, extra: 1 }).success).toBe(true);
  });

  it("rejects a duplicate tool name", () => {
    const spec = {
      name: "tm1_spec_duplicate",
      description: "fixture",
      annotations: READ_ONLY,
      input: { cubeName: z.string() },
      handler: ok,
    };
    defineTool(spec);
    expect(() => defineTool(spec)).toThrow(/duplicate tool name/);
  });

  it("joins an array description with single spaces", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    let config: Record<string, unknown> | undefined;
    server.registerTool = ((...args: unknown[]) => {
      config = args[1] as Record<string, unknown>;
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;

    const register = defineTool({
      name: "tm1_spec_desc_array",
      description: ["first line.", "second line."],
      annotations: READ_ONLY,
      input: { cubeName: z.string() },
      handler: ok,
    });
    register(withAnnotations(server, mockLogger, "readwrite"), fakeClient);

    expect(config?.description).toBe("first line. second line.");
  });

  it("supplies annotations and outputSchema to the registration Proxy", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    let config: Record<string, unknown> | undefined;
    server.registerTool = ((...args: unknown[]) => {
      config = args[1] as Record<string, unknown>;
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;

    const register = defineTool({
      name: "tm1_spec_wired",
      description: "fixture",
      annotations: DESTRUCTIVE,
      output: z.object({ success: z.boolean() }),
      input: { cubeName: z.string() },
      handler: ok,
    });
    register(withAnnotations(server, mockLogger, "readwrite"), fakeClient);

    expect(config?.annotations).toEqual(DESTRUCTIVE);
    expect(config?.outputSchema).toBeDefined();
    expect(config?.title).toBe("Spec Wired");
  });

  it("hands the shared TM1 client to the handler", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    let cb: ((...a: unknown[]) => unknown) | undefined;
    server.registerTool = ((...args: unknown[]) => {
      cb = args[2] as (...a: unknown[]) => unknown;
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;

    let seen: TM1Client | undefined;
    const register = defineTool({
      name: "tm1_spec_client",
      description: "fixture",
      annotations: READ_ONLY,
      input: { cubeName: z.string() },
      handler: (_args, tm1Client) => {
        seen = tm1Client;
        return ok();
      },
    });
    register(withAnnotations(server, mockLogger, "readwrite"), fakeClient);
    await cb?.({ cubeName: "Cube_Fixture" });

    expect(seen).toBe(fakeClient);
  });

  it("is filtered out of readonly mode when the spec is not read-only", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const registered: string[] = [];
    server.registerTool = ((...args: unknown[]) => {
      registered.push(args[0] as string);
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;
    const wrapped = withAnnotations(server, mockLogger, "readonly");

    defineTool({
      name: "tm1_spec_readonly_kept",
      description: "fixture",
      annotations: READ_ONLY,
      input: { cubeName: z.string() },
      handler: ok,
    })(wrapped, fakeClient);
    defineTool({
      name: "tm1_spec_write_dropped",
      description: "fixture",
      annotations: DESTRUCTIVE,
      input: { cubeName: z.string() },
      handler: ok,
    })(wrapped, fakeClient);

    expect(registered).toEqual(["tm1_spec_readonly_kept"]);
  });
});
