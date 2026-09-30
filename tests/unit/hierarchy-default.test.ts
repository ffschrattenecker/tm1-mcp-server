import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { resolveHierarchy } from "../../src/tools/hierarchy.js";
import { mockLogger } from "../helpers/client-harness.js";

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
  "tm1_bulk_upsert_elements",
  "tm1_delete_elements",
  "tm1_update_element_attribute_value",
];

describe("hierarchyName default", () => {
  const schemas = collectInputSchemas();

  it.each(DEFAULTED)("%s accepts a call without hierarchyName", (tool) => {
    const shape = schemas.get(tool);
    expect(shape, `${tool} not registered`).toBeDefined();
    expect(shape!.hierarchyName?.isOptional()).toBe(true);
  });

  it("resolves to the dimension name only when hierarchyName is absent", () => {
    expect(resolveHierarchy("Region", undefined)).toBe("Region");
    expect(resolveHierarchy("Region", "Alt")).toBe("Alt");
  });
});
