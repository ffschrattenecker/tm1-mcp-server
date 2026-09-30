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
import type { TM1Client } from "../../src/tm1-client.js";
import { defineTool, specFor } from "../../src/tools/define-tool.js";
import { READ_ONLY, DESTRUCTIVE } from "../../src/tools/annotations.js";
import { strictVariants } from "../../src/tools/schemas/markdown-capable.js";
import { FORMAT_SCHEMA } from "../../src/tools/format.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { mockLogger } from "../helpers/client-harness.js";

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

describe("defineTool with several connections", () => {
  const v11 = { version: 11 } as TM1Client;
  const v12 = { version: 12 } as TM1Client;
  const registry = ConnectionRegistry.of([
    { name: "dev", client: v11, mode: "readwrite" },
    { name: "prod", client: v12, mode: "readonly" },
  ]);

  function capture() {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const tools = new Map<
      string,
      { config: Record<string, unknown>; cb: (...a: unknown[]) => unknown }
    >();
    server.registerTool = ((...args: unknown[]) => {
      tools.set(args[0] as string, {
        config: args[1] as Record<string, unknown>,
        cb: args[2] as (...a: unknown[]) => unknown,
      });
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;
    return { wrapped: withAnnotations(server, mockLogger, "readwrite"), tools };
  }

  const errorText = (r: unknown) =>
    (r as { content: { text: string }[] }).content[0].text;

  it("adds a required `connection` enum and routes the call to that client", async () => {
    const { wrapped, tools } = capture();
    let seen: { args: unknown; client: TM1Client } | undefined;
    defineTool({
      name: "tm1_spec_multi_route",
      description: "fixture",
      annotations: READ_ONLY,
      input: { cubeName: z.string() },
      handler: (args, client) => {
        seen = { args, client };
        return ok();
      },
    })(wrapped, registry);

    const tool = tools.get("tm1_spec_multi_route")!;
    const input = tool.config.inputSchema as z.ZodRawShape;
    expect(Object.keys(input)).toEqual(["cubeName", "connection"]);
    expect(
      (input.connection as unknown as { options: string[] }).options,
    ).toEqual(["dev", "prod"]);

    await tool.cb({ cubeName: "C", connection: "prod" });
    expect(seen?.client).toBe(v12);
    // The handler never sees the routing argument.
    expect(seen?.args).toEqual({ cubeName: "C" });
  });

  it("refuses a write tool against a readonly connection", async () => {
    const { wrapped, tools } = capture();
    const handler = vi.fn(ok);
    defineTool({
      name: "tm1_spec_multi_write",
      description: "fixture",
      annotations: DESTRUCTIVE,
      input: { cubeName: z.string() },
      handler,
    })(wrapped, registry);

    const result = await tools
      .get("tm1_spec_multi_write")!
      .cb({ cubeName: "C", connection: "prod" });
    expect(errorText(result)).toMatch(/PERMISSION_DENIED/);
    expect(errorText(result)).toMatch(/prod.{0,2} is readonly/);
    expect(handler).not.toHaveBeenCalled();

    await tools
      .get("tm1_spec_multi_write")!
      .cb({ cubeName: "C", connection: "dev" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("registers a version-gated tool when any connection matches, refusing the others", async () => {
    const { wrapped, tools } = capture();
    const handler = vi.fn(ok);
    defineTool({
      name: "tm1_spec_multi_v11",
      description: "fixture",
      annotations: READ_ONLY,
      version: 11,
      input: {},
      handler,
    })(wrapped, registry);

    const result = await tools
      .get("tm1_spec_multi_v11")!
      .cb({ connection: "prod" });
    expect(errorText(result)).toMatch(/needs TM1 v11/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips a version-gated tool no connection can serve", () => {
    const { wrapped, tools } = capture();
    defineTool({
      name: "tm1_spec_single_v12_only",
      description: "fixture",
      annotations: READ_ONLY,
      version: 12,
      input: {},
      handler: ok,
    })(wrapped, ConnectionRegistry.single(v11));

    expect(tools.has("tm1_spec_single_v12_only")).toBe(false);
  });

  it("peer tools take an optional connectionB and get both clients", async () => {
    const { wrapped, tools } = capture();
    let sides:
      | {
          a: { name: string; client: TM1Client };
          b: { name: string; client: TM1Client };
        }
      | undefined;
    let seenArgs: unknown;
    defineTool({
      name: "tm1_spec_peer",
      description: "fixture",
      annotations: READ_ONLY,
      peer: true,
      input: { cubeName: z.string() },
      handler: (args, s) => {
        seenArgs = args;
        sides = s;
        return ok();
      },
    })(wrapped, registry);

    const tool = tools.get("tm1_spec_peer")!;
    const input = tool.config.inputSchema as z.ZodRawShape;
    expect(Object.keys(input)).toEqual([
      "cubeName",
      "connection",
      "connectionB",
    ]);

    await tool.cb({ cubeName: "C", connection: "dev", connectionB: "prod" });
    expect(sides?.a).toEqual({ name: "dev", client: v11 });
    expect(sides?.b).toEqual({ name: "prod", client: v12 });
    expect(seenArgs).toEqual({ cubeName: "C" });

    // connectionB defaults to connection.
    await tool.cb({ cubeName: "C", connection: "prod" });
    expect(sides?.a.client).toBe(v12);
    expect(sides?.b.client).toBe(v12);
  });

  it("applies the version gate to the peer side too", async () => {
    const { wrapped, tools } = capture();
    const handler = vi.fn(ok);
    defineTool({
      name: "tm1_spec_peer_v11",
      description: "fixture",
      annotations: READ_ONLY,
      version: 11,
      peer: true,
      input: {},
      handler,
    })(wrapped, registry);

    const result = await tools
      .get("tm1_spec_peer_v11")!
      .cb({ connection: "dev", connectionB: "prod" });
    expect(errorText(result)).toMatch(/needs TM1 v11/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a single connection exposes no connectionB and compares it with itself", async () => {
    const { wrapped, tools } = capture();
    let sides:
      { a: { client: TM1Client }; b: { client: TM1Client } } | undefined;
    defineTool({
      name: "tm1_spec_peer_single",
      description: "fixture",
      annotations: READ_ONLY,
      peer: true,
      input: {},
      handler: (_args, s) => {
        sides = s;
        return ok();
      },
    })(wrapped, ConnectionRegistry.single(v11));

    const tool = tools.get("tm1_spec_peer_single")!;
    expect(Object.keys(tool.config.inputSchema as object)).toEqual([]);
    await tool.cb({});
    expect(sides?.a.client).toBe(v11);
    expect(sides?.b.client).toBe(v11);
  });
});

describe("peer spec validation", () => {
  it("refuses a peer tool that is not read-only", () => {
    expect(() =>
      defineTool({
        name: "tm1_spec_peer_write",
        description: "fixture",
        annotations: DESTRUCTIVE,
        peer: true,
        input: {},
        handler: ok,
      }),
    ).toThrow(/must be READ_ONLY/);
  });
});

describe("connectionless tools", () => {
  it("take no `connection` argument and receive the registry", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    let config: Record<string, unknown> | undefined;
    let cb: ((...a: unknown[]) => unknown) | undefined;
    server.registerTool = ((...args: unknown[]) => {
      config = args[1] as Record<string, unknown>;
      cb = args[2] as (...a: unknown[]) => unknown;
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;
    const registry = ConnectionRegistry.of([
      { name: "a", client: fakeClient },
      { name: "b", client: fakeClient },
    ]);

    let seen: unknown;
    defineTool({
      name: "tm1_spec_connectionless",
      description: "fixture",
      annotations: READ_ONLY,
      input: {},
      connectionless: true,
      handler: (_args, reg) => {
        seen = reg;
        return ok();
      },
    })(withAnnotations(server, mockLogger, "readwrite"), registry);

    expect(Object.keys(config?.inputSchema as object)).toEqual([]);
    await cb?.({});
    expect(seen).toBe(registry);
  });
});
