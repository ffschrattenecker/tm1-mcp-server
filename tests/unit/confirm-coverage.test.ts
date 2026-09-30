import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { mockLogger } from "../helpers/client-harness.js";

// Capture each registered tool's inputSchema (the raw zod shape) by intercepting
// registerTool, mirroring tests/unit/tool-registration.test.ts.
function collectInputSchemas(): Map<string, Record<string, unknown>> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const schemas = new Map<string, Record<string, unknown>>();
  const original = server.registerTool.bind(server);
  server.registerTool = (...args: unknown[]) => {
    const name = args[0] as string;
    const config = args[1] as { inputSchema?: Record<string, unknown> };
    schemas.set(name, config?.inputSchema ?? {});
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

// Tools that MUST carry the confirmation guard (CONFIRM_SCHEMA `confirm` field).
// Losing it silently would let an auto-approve client fire an irreversible
// destructive op without repeating the target name. This gate fails if any of
// these drops the field.
//
// 9.0.0: single-object deletes go through tm1_rest_write, which asks for
// confirm = the key of the object a DELETE or cancel/close action hits.
const CONFIRM_REQUIRED = [
  "tm1_rest_write",
  "tm1_files_write",
  "tm1_clear_cube",
  "tm1_delete_elements",
  // K2/S9 (2026-08-05): the guard used to cover object DESTRUCTION only, so this
  // list read as complete while irreversible writes and TI side-effects sat
  // outside it. A tool that overwrites data, or runs code whose effects the
  // caller cannot undo, belongs here just as much as a delete.
  "tm1_execute_process",
  "tm1_execute_chore",
  "tm1_write_cells",
  "tm1_set_cube_rules",
  // 5.0.0: create-or-update tools confirm an OVERWRITE (optional field, required
  // at runtime once the target exists).
  "tm1_upsert_process",
  "tm1_import_pro_file",
  "tm1_import_process_from_git",
  "tm1_install_pro_bundle",
  // …and bulk_upsert_elements when components would drop existing children.
  "tm1_bulk_upsert_elements",
];

describe("confirmation-guard coverage", () => {
  const schemas = collectInputSchemas();

  it.each(CONFIRM_REQUIRED)("%s declares a `confirm` input", (toolName) => {
    const inputSchema = schemas.get(toolName);
    expect(inputSchema, `${toolName} is not registered`).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(inputSchema, "confirm"),
      `${toolName} must declare a \`confirm\` field (CONFIRM_SCHEMA) to guard the destructive action`,
    ).toBe(true);
  });
});
