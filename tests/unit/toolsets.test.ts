import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { parseToolsets, toolsetsCacheKey } from "../../src/tools/toolsets.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { ConnectionRegistry } from "../../src/connections.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { mockLogger } from "../helpers/client-harness.js";

describe("TM1_TOOLSETS", () => {
  it("parses unset, empty, and 'all' as unfiltered", () => {
    expect(parseToolsets(undefined)).toBeUndefined();
    expect(parseToolsets("")).toBeUndefined();
    expect(parseToolsets("  ")).toBeUndefined();
    expect(parseToolsets("all")).toBeUndefined();
    expect(parseToolsets("core, all")).toBeUndefined();
  });

  it("expands presets and aliases", () => {
    const core = parseToolsets("core")!;
    expect([...core].sort()).toEqual([
      "celldata",
      "metadata",
      "operations",
      "rest",
    ]);

    const aliased = parseToolsets("ti, rules, files")!;
    expect([...aliased].sort()).toEqual([
      "fileops",
      "model-building",
      "ti-development",
    ]);
    expect(toolsetsCacheKey(aliased)).toBe(
      "fileops,model-building,ti-development",
    );
  });

  it("rejects unknown toolset names at startup", () => {
    expect(() => parseToolsets("bogus")).toThrow(/Invalid TM1_TOOLSETS/);
  });

  it("filters registered tools while always keeping tm1_list_connections", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const names: string[] = [];
    const orig = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...rest: unknown[]) => {
      names.push(name);
      return (orig as (...a: unknown[]) => unknown)(name, ...rest);
    }) as typeof server.registerTool;

    const registry = ConnectionRegistry.single({ version: 11 } as TM1Client);
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    registerAllTools(wrapped, registry, parseToolsets("rest"));

    expect(names).toEqual([
      "tm1_list_connections",
      "tm1_rest_read",
      "tm1_rest_write",
    ]);
  });
});
