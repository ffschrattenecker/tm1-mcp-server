import { describe, expect, it, vi } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
// Output schemas come from the defineTool() specs; registerAllTools is
// imported above, so every spec has been defined.
import { allSpecs } from "../../src/tools/define-tool.js";

const OUTPUT_SCHEMAS = new Map(
  [...allSpecs()].flatMap(([name, meta]) =>
    meta.outputSchema === undefined ? [] : [[name, meta.outputSchema] as const],
  ),
);

// OUTPUT_SCHEMA_MAP entries are either a ZodRawShape (legacy) or a full
// ZodTypeAny (used when the schema relies on .passthrough() / .catchall(),
// since `.shape` extraction would discard those flags). Wrap shapes back into
// an object schema for parsing; pass full schemas through unchanged.
function asSchema(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  return typeof entry === "object" && entry !== null && "_def" in entry
    ? (entry as ZodTypeAny)
    : z.object(entry);
}

// Parseable schema for a tool, or a loud failure — every tool named in this
// suite is expected to declare one.
function schemaOf(toolName: string): ZodTypeAny {
  const entry = OUTPUT_SCHEMAS.get(toolName);
  if (entry === undefined) {
    throw new Error(`${toolName} declares no output schema`);
  }
  return asSchema(entry);
}

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

// Version-gated tools (tm1_save_data, v11 only) register under one version at
// a time — union both so "registered" reflects full coverage.
function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const version of [11, 12] as const) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const orig = server.registerTool.bind(server);
    server.registerTool = (...args: unknown[]) => {
      names.add(args[0] as string);
      return (orig as (...a: unknown[]) => unknown)(...args) as ReturnType<
        typeof server.registerTool
      >;
    };
    registerAllTools(
      withAnnotations(server, mockLogger, "readwrite"),
      contractCheckedClient({
        version,
      } as unknown as TM1Client),
    );
  }
  return names;
}

describe("declared output schemas", () => {
  it("every declared output schema belongs to a registered tool (no orphans)", () => {
    const registered = registeredToolNames();
    const orphans = [...OUTPUT_SCHEMAS.keys()].filter(
      (k) => !registered.has(k),
    );
    expect(orphans).toEqual([]);
  });

  // Live-sweep regression 2026-07-12: the not-found branch omitted choreName/
  // tasks and was rejected by the strict output schema (surfaced as isError
  // via the drift pre-validation). Both branches must conform.
  it("tm1_analyze_chore_graph: not-found warning payload validates against schema", () => {
    const schema = schemaOf("tm1_analyze_chore_graph");
    const payload = {
      choreName: "ZZZ_missing",
      tasks: [],
      warning: 'Chore "ZZZ_missing" not found.',
      indexedChoreCount: 12,
    };
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new Error(
        `warning-branch validation failed: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
  });

  // ── Phase 2 fixtures ────────────────────────────────────────────────────
  const PHASE2_SAMPLES: Record<string, unknown> = {
    tm1_check_writable_coords: {
      cube: "Sales",
      writable: true,
      allElementsExist: true,
      allElementsNLevel: true,
      coords: [],
    },
    tm1_validate_process_refs: {
      processName: "Load.Sales",
      cubeRefsScanned: 3,
      dimensionRefsScanned: 5,
      elementRefsScanned: 4,
      unresolved: 0,
      issues: [],
      tabsChecked: ["prolog", "data"],
      unresolvableArgs: 0,
      partial: false,
    },
    tm1_get_view: {
      cubeName: "Sales",
      viewName: "Default",
      axes: [
        {
          tuples: [{ members: [{ name: "EU", hierarchyName: "Region" }] }],
        },
      ],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [{ value: 100, formattedValue: "100.00" }],
    },
    tm1_get_process: {
      name: "Load.Sales",
      prolog: "# pro",
      metadata: "",
      data: "",
      epilog: "",
      parameters: [{ name: "pYear", type: "String", defaultValue: "2026" }],
      variables: [{ name: "vAmount", type: "Numeric", position: 1 }],
      dataSource: { type: "None" },
      hasSecurityAccess: false,
    },
    tm1_get_all_cube_rules: {
      count: 1,
      countIsExact: true,
      returned: 1,
      truncated: false,
      cubes: [{ cubeName: "Sales", rulesText: "[]=N:1;", skipCheck: false }],
    },
    tm1_get_all_processes_code: {
      count: 2,
      countIsExact: true,
      returned: 2,
      truncated: false,
      processes: [
        // Full mode: tab bodies present.
        {
          name: "Load.Sales",
          hasSecurityAccess: false,
          prolog: "# pro",
          metadata: "",
          data: "",
          epilog: "",
        },
        // Summary mode: bodies replaced by line metrics.
        {
          name: "Load.Fx",
          hasSecurityAccess: true,
          totalLines: 5,
          prologLines: 5,
          metadataLines: 0,
          dataLines: 0,
          epilogLines: 0,
          commentLines: 2,
        },
      ],
    },
    tm1_execute_mdx: {
      axes: [
        {
          tuples: [{ members: [{ name: "EU", hierarchyName: "Region" }] }],
        },
      ],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [{ value: 100, formattedValue: "100.00" }],
    },
    tm1_execute_process: {
      success: true,
      outcome: "succeeded",
      processErrorStatus: "CompletedSuccessfully",
    },
    tm1_diff_process_with_file: {
      processName: "Load.Sales",
      identical: true,
      tabs: [],
      parameters: [],
      variables: [],
      ignoredColumns: { identical: true, added: [], removed: [], renamed: [] },
      dataSource: [],
    },
    tm1_upsert_process: {
      processName: "Load.Sales",
      action: "updated",
      appliedSteps: ["compile", "save"],
    },
    tm1_install_pro_bundle: {
      directory: "bundle/",
      filesFound: 2,
      dryRun: false,
      mode: "upsert",
      counts: {
        created: 1,
        updated: 1,
        preflight_failed: 0,
        error: 0,
        skipped: 0,
      },
      results: [
        { file: "a.pro", processName: "A", status: "created" },
        { file: "b.pro", processName: "B", status: "updated" },
        { file: "c.pro", processName: null, status: "preflight_failed" },
      ],
    },
    tm1_import_pro_file: {
      action: "created",
      processName: "Load.Sales",
      parsed: {
        prologLines: 5,
        metadataLines: 0,
        dataLines: 10,
        epilogLines: 2,
        parameterCount: 1,
        variableCount: 3,
        dataSourceType: "ASCII",
      },
    },
    tm1_export_process_to_git: {
      processName: "Load.Sales",
      jsonFileName: "Load.Sales.json",
      tiFileName: "Load.Sales.ti",
      parameterCount: 1,
      variableCount: 3,
      dataSourceType: "ASCII",
      credentialsOmitted: false,
      hasSecurityAccess: false,
      writtenTo: { json: null, ti: null },
      json: '{\n  "name": "Load.Sales",\n  "parameters": [],\n  "variables": [],\n  "dataSource": { "type": "ASCII" }\n}\n',
      ti: "### TM1-TI-TAB: prolog ###\nsX=1;\n### TM1-TI-TAB: metadata ###\n### TM1-TI-TAB: data ###\n### TM1-TI-TAB: epilog ###\n",
    },
    tm1_import_process_from_git: {
      action: "created",
      processName: "Load.Sales",
      hasSecurityAccess: false,
      parsed: {
        prologLines: 5,
        metadataLines: 0,
        dataLines: 10,
        epilogLines: 2,
        parameterCount: 1,
        variableCount: 3,
        dataSourceType: "ASCII",
      },
    },
    tm1_copy_process: {
      success: true,
      sourceName: "Load.Sales",
      targetName: "Load.Sales.Copy",
    },
    tm1_analyze_callgraph: {
      start: "Load.Sales",
      direction: "downstream",
      mode: "full",
      maskSecrets: false,
      tree: {
        process: "Load.Sales",
        cycle: false,
        incomingEdge: null,
        children: [],
      },
    },
    tm1_analyze_chore_graph: {
      choreName: "Daily.Load",
      tasks: [
        {
          step: 0,
          processName: "Load.Sales",
          choreParams: {},
          tree: { name: "Load.Sales", children: [] },
        },
      ],
    },
    tm1_analyze_object_usage: {
      kind: "cube",
      name: "Sales",
      accessMode: "all",
      count: 2,
      returned: 2,
      truncated: false,
      usages: [{ process: "Load.Sales" }, { process: "Clear.Sales" }],
    },
    tm1_search_code: {
      pattern: "CellPutN",
      caseSensitive: false,
      tabsSearched: ["prolog", "data"],
      processesScanned: 50,
      matchCount: 2,
      truncated: false,
      maskSecrets: true,
      excludeCommented: false,
      total: 2,
      count: 2,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        { process: "Load.Sales", tab: "data", line: 12, text: "CellPutN(...)" },
        { process: "Load.Costs", tab: "data", line: 8, text: "CellPutN(...)" },
      ],
    },
    tm1_check_cube_rule: {
      ok: true,
      cube: "Sales",
      lineCount: 5,
      errorCount: 0,
      errors: [],
    },
    tm1_check_process_code: {
      ok: false,
      processName: "_compile_check",
      errorCount: 1,
      errors: [{ procedure: "Prolog", lineNumber: 3, message: "syntax" }],
      tabsChecked: ["prolog"],
      partial: true,
    },
    tm1_get_cube_rules: {
      cubeName: "Sales",
      rulesText: "[]=N:1;",
      skipCheck: false,
    },
    tm1_get_cube_stats: {
      count: 1,
      items: [
        {
          cubeName: "Sales",
          populatedNumeric: 12500,
          populatedString: 0,
          fedCells: 18000,
          memoryFeeders: 524288,
          memoryTotal: 8912896,
          feederEfficiency: 1.44,
          raw: {
            "Memory Used for Feeders": 524288,
            "Number of Populated Numeric Cells": 12500,
            "Number of Fed Cells": 18000,
            "Total Memory Used": 8912896,
          },
        },
      ],
    },
    tm1_list_error_logs: {
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        {
          filename: "Load.Sales_20260504_123045.log",
          lastUpdated: "2026-05-04T12:30:45Z",
        },
      ],
    },
    tm1_get_error_log_content: {
      filename: "Load.Sales_20260504_123045.log",
      totalBytes: 256,
      returnedBytes: 256,
      truncated: false,
      content:
        "ERROR: Process 'Load.Sales' line 12 — Invalid dimension 'Foo'\n",
    },
    // Generic mutation envelope: success + per-tool extras flow through
    // passthrough. One fixture per shape variant is enough to lock behavior.
    tm1_clear_cube: {
      success: true,
      cubeName: "Sales",
      summary: "all cells",
    },
    tm1_update_element_attribute_value: {
      success: true,
      dimensionName: "Region",
      elementName: "DE",
      attributeName: "Currency",
      value: "EUR",
    },
    tm1_write_cells: { success: true, cellsWritten: 100 },
  };

  for (const [toolName, payload] of Object.entries(PHASE2_SAMPLES)) {
    it(`${toolName}: structured output validates against schema`, () => {
      const result = schemaOf(toolName).safeParse(payload);
      if (!result.success) {
        throw new Error(
          `${toolName} validation failed: ${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
    });
  }
});
