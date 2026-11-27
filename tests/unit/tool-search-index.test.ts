import { describe, it, expect } from "vitest";
import { loadServerSettings } from "../../src/config.js";
import { ConnectionRegistry } from "../../src/connections.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { getCompiledToolSurface } from "../../src/tools/compiled-surface.js";
import {
  type ToolSearchIndex,
  stemToken,
  summarizeDescription,
  tokenize,
} from "../../src/tools/discovery/search-index.js";
import { mockLogger } from "../helpers/client-harness.js";

function buildFullIndex(): ToolSearchIndex {
  const client = { version: 11, connectionId: "idx:1" } as unknown as TM1Client;
  const registry = ConnectionRegistry.of([
    { name: "dev", client, mode: "readwrite" },
  ]);
  const settings = loadServerSettings({ TM1_TOOL_DISCOVERY: "search" });
  const surface = getCompiledToolSurface(registry, settings, mockLogger);
  return surface.searchProjection!.index;
}

describe("tokenizer and stemmer", () => {
  it("splits camelCase, keeps v11/v12 and 'all', and drops stop words", () => {
    expect(tokenize("getAllCubeRules v12Readiness")).toEqual([
      "get",
      "all",
      "cube",
      "rule",
      "v12",
      "readiness",
    ]);
    expect(tokenize("the tm1 tool for cubes and dimensions")).toEqual([
      "tool",
      "cube",
      "dimension",
    ]);
  });

  it("stems TM1 domain plurals and gerunds deterministically", () => {
    expect(stemToken("axes")).toBe("axis");
    expect(stemToken("hierarchies")).toBe("hierarchy");
    expect(stemToken("processes")).toBe("process");
    expect(stemToken("sandboxes")).toBe("sandbox");
    expect(stemToken("overfeeding")).toBe("overfeed");
  });

  it("summarizes descriptions cleanly without splitting abbreviations", () => {
    const desc =
      "Find elements (e.g. accounts or cost centers). Extra detail follows.";
    expect(summarizeDescription(desc, 160)).toBe(
      "Find elements (e.g. accounts or cost centers)",
    );
  });
});

describe("ToolSearchIndex — BM25F ranking across all 72 tools", () => {
  const index = buildFullIndex();

  it("indexes the full v11 readwrite toolset", () => {
    expect(index.size).toBe(72);
  });

  it("returns exact tool-name match as top-1 solo hit", () => {
    const hits = index.search({ query: "tm1_get_cube_rules" });
    expect(hits.map((h) => h.doc.name)).toEqual(["tm1_get_cube_rules"]);
  });

  it.each<[string, string[]]>([
    ["clear cube", ["tm1_clear_cube"]],
    ["execute mdx", ["tm1_execute_mdx"]],
    ["mdx set expression", ["tm1_execute_mdx_set"]],
    ["user permissions", ["tm1_inspect_security"]],
    ["lock contention", ["tm1_get_activity"]],
    ["transaction log", ["tm1_query_logs"]],
    ["SaveDataAll", ["tm1_save_data"]],
    ["overfeeding", ["tm1_audit_feeders"]],
    ["reorder storage dimensions", ["tm1_reorder_cube_dimensions"]],
    ["PAE v12 migration", ["tm1_check_v12_readiness"]],
    ["compare environments", ["tm1_compare_environments"]],
    ["failed process error", ["tm1_diagnose_process_error"]],
    ["compile cube rule", ["tm1_check_cube_rule"]],
    ["ASCIIOutput file", ["tm1_read_server_file"]],
    [
      "search TI process code",
      ["tm1_search_code", "tm1_get_all_processes_code"],
    ],
    ["TurboIntegrator process", ["tm1_execute_process", "tm1_get_process"]],
    [
      "what-if sandbox",
      [
        "tm1_create_sandbox",
        "tm1_list_sandboxes",
        "tm1_compare_sandbox",
        "tm1_delete_sandbox",
        "tm1_discard_sandbox",
        "tm1_publish_sandbox",
      ],
    ],
    ["naming conventions", ["tm1_audit_naming"]],
    ["chore graph", ["tm1_analyze_chore_graph"]],
    ["callgraph", ["tm1_analyze_callgraph"]],
    ["data flow", ["tm1_trace_data_flow"]],
    ["trace feeders", ["tm1_trace_feeders"]],
    ["check feeders", ["tm1_check_feeders"]],
    ["write cells", ["tm1_write_cells"]],
    ["sample cells", ["tm1_sample_cells"]],
    ["delete elements", ["tm1_delete_elements"]],
    ["update chore", ["tm1_update_chore"]],
    ["server state", ["tm1_get_server_state"]],
  ])("ranks expected tool(s) at top for %j", (query, expectedTop) => {
    const hits = index.search({ query });
    expect(hits.length).toBeGreaterThan(0);
    expect(expectedTop).toContain(hits[0]?.doc.name);
  });

  it("applies 70% relative score cutoff to keep specific queries tight", () => {
    const hits = index.search({ query: "clear cube" });
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits[0]?.doc.name).toBe("tm1_clear_cube");
  });

  it("allows broad queries to return multiple relevant tools up to cap", () => {
    const hits = index.search({ query: "sandbox" });
    expect(hits.length).toBeGreaterThanOrEqual(6);
    const names = new Set(hits.map((h) => h.doc.name));
    expect(names.has("tm1_create_sandbox")).toBe(true);
    expect(names.has("tm1_list_sandboxes")).toBe(true);
    expect(names.has("tm1_compare_sandbox")).toBe(true);
  });

  it("respects limit, toolset, and access filters", () => {
    const readOnlySandboxes = index.search({
      toolset: "sandboxes",
      access: "read",
    });
    expect(readOnlySandboxes.map((m) => m.doc.name)).toEqual([
      "tm1_compare_sandbox",
      "tm1_list_sandboxes",
    ]);

    const limited = index.search({ query: "sandbox", limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("returns empty list when neither query nor filters are provided", () => {
    expect(index.search({})).toEqual([]);
  });
});
