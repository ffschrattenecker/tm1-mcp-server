import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerDeleteElement } from "../../src/tools/dimension-management/delete-element.js";
import { registerListSubsets } from "../../src/tools/subsets/list-subsets.js";
import { resolveHierarchy } from "../../src/tools/hierarchy.js";

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

function collectInputSchemas(): Map<string, Record<string, ZodTypeAny>> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const schemas = new Map<string, Record<string, ZodTypeAny>>();
  const original = server.registerTool.bind(server);
  server.registerTool = (...args: unknown[]) => {
    const config = args[1] as { inputSchema?: Record<string, ZodTypeAny> };
    schemas.set(args[0] as string, config?.inputSchema ?? {});
    return (original as (...a: unknown[]) => unknown)(...args) as ReturnType<
      typeof server.registerTool
    >;
  };
  registerAllTools(
    withAnnotations(server, mockLogger, "readwrite"),
    {} as TM1Client,
  );
  return schemas;
}

// The tools that take a hierarchy as a locator, not as their subject. Omitting
// hierarchyName was the most common -32602 in recorded usage; these default it
// to the dimension's same-named hierarchy.
const DEFAULTED = [
  "tm1_get_hierarchy",
  "tm1_get_ancestors",
  "tm1_get_descendants",
  "tm1_create_element",
  "tm1_update_element",
  "tm1_delete_element",
  "tm1_move_element",
  "tm1_bulk_upsert_elements",
  "tm1_list_element_attributes",
  "tm1_create_element_attribute",
  "tm1_create_subset",
  "tm1_get_subset",
  "tm1_update_subset",
  "tm1_delete_subset",
  "tm1_list_subsets",
];

// The hierarchy IS the subject: there is no sensible default. The same-named
// hierarchy already exists and cannot be deleted on its own.
const REQUIRED = ["tm1_create_hierarchy", "tm1_delete_hierarchy"];

describe("hierarchyName default", () => {
  const schemas = collectInputSchemas();

  it.each(DEFAULTED)("%s accepts a call without hierarchyName", (tool) => {
    const shape = schemas.get(tool);
    expect(shape, `${tool} not registered`).toBeDefined();
    expect(shape!.hierarchyName?.isOptional()).toBe(true);
  });

  it.each(REQUIRED)("%s still requires hierarchyName", (tool) => {
    expect(schemas.get(tool)!.hierarchyName?.isOptional()).toBe(false);
  });

  it("resolves to the dimension name only when hierarchyName is absent", () => {
    expect(resolveHierarchy("Region", undefined)).toBe("Region");
    expect(resolveHierarchy("Region", "Alt")).toBe("Alt");
  });
});

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function capture(register: (s: never, c: TM1Client) => void, client: unknown) {
  let handler: Handler | undefined;
  let parser: z.ZodObject<ZodRawShape> | undefined;
  const server = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: Handler) => {
      parser = z.object(schema);
      handler = h;
    },
  };
  register(server as never, client as TM1Client);
  return (args: Record<string, unknown>) => handler!(parser!.parse(args));
}

describe("handlers pass the effective hierarchy to the service", () => {
  it("delete_element targets the same-named hierarchy when omitted", async () => {
    const calls: unknown[][] = [];
    const call = capture(registerDeleteElement, {
      elements: { delete: async (...a: unknown[]) => void calls.push(a) },
    });
    await call({ dimensionName: "Region", elementName: "EU", confirm: "EU" });
    expect(calls).toEqual([["Region", "Region", "EU"]]);
  });

  it("list_subsets keeps an explicit hierarchy", async () => {
    const calls: unknown[][] = [];
    const call = capture(registerListSubsets, {
      subsets: {
        list: async (...a: unknown[]) => {
          calls.push(a);
          return [];
        },
      },
    });
    await call({ dimensionName: "Region", hierarchyName: "Alt" });
    expect(calls).toEqual([["Region", "Alt"]]);
  });
});
