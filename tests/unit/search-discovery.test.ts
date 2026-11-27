import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import {
  InMemoryTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/build-mcp-server.js";
import { loadServerSettings, type ServerSettings } from "../../src/config.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { startHttpTransport } from "../../src/http-transport.js";
import {
  Tm1TaskManager,
  TASKS_EXTENSION_ID,
} from "../../src/tasks/tm1-task-manager.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { getCompiledToolSurface } from "../../src/tools/compiled-surface.js";
import { mockLogger } from "../helpers/client-harness.js";

async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "search-test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function makeFakeClient(opts?: {
  onClearCube?: (cube: string) => void;
  onGetRules?: (cube: string) => void;
  onCreateSandbox?: (name: string) => void;
}): TM1Client {
  return {
    version: 11,
    connectionId: "fake:1",
    cubes: {
      getRules: async (cube: string) => {
        opts?.onGetRules?.(cube);
        return {
          cubeName: cube,
          rulesText: "SKIPCHECK;\nFEEDERS;\n",
          skipCheck: true,
        };
      },
      clear: async (cube: string) => {
        opts?.onClearCube?.(cube);
        return { success: true };
      },
    },
    sandboxes: {
      create: async (name: string) => {
        opts?.onCreateSandbox?.(name);
        return {
          Name: name,
          IsActive: false,
          IsLoaded: false,
          IsQueued: false,
        };
      },
    },
  } as unknown as TM1Client;
}

describe("TM1_TOOL_DISCOVERY=search", () => {
  it("exposes 6 tools in readonly mode (no tm1_call_write_tool) and >10x smaller payload", async () => {
    const client = makeFakeClient();
    const registry = ConnectionRegistry.of([
      { name: "dev", client, mode: "readonly" },
    ]);
    const fullServer = buildMcpServer(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "full" }),
      mockLogger,
    );
    const searchServer = buildMcpServer(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "search" }),
      mockLogger,
    );

    const fullClient = await connectInMemory(fullServer);
    const searchClient = await connectInMemory(searchServer);

    const fullList = await fullClient.listTools();
    const searchList = await searchClient.listTools();
    const names = searchList.tools.map((t) => t.name);

    expect(names).toEqual([
      "tm1_execute_mdx",
      "tm1_list_connections",
      "tm1_rest_read",
      "tm1_search_tools",
      "tm1_describe_tool",
      "tm1_call_read_tool",
    ]);
    expect(names).not.toContain("tm1_call_write_tool");

    const fullBytes = JSON.stringify(fullList.tools).length;
    const searchBytes = JSON.stringify(searchList.tools).length;
    expect(fullBytes / searchBytes).toBeGreaterThan(10);

    await Promise.all([
      fullClient.close(),
      searchClient.close(),
      fullServer.close(),
      searchServer.close(),
    ]);
  });

  it("exposes 7 tools in sandbox mode (no taskSupport tools pinned)", async () => {
    const client = makeFakeClient();
    const registry = ConnectionRegistry.of([
      { name: "dev", client, mode: "sandbox" },
    ]);
    const server = buildMcpServer(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "search" }),
      mockLogger,
    );
    const mcp = await connectInMemory(server);
    const list = await mcp.listTools();
    const names = list.tools.map((t) => t.name);

    expect(names).toEqual([
      "tm1_execute_mdx",
      "tm1_list_connections",
      "tm1_rest_read",
      "tm1_search_tools",
      "tm1_describe_tool",
      "tm1_call_read_tool",
      "tm1_call_write_tool",
    ]);

    const searchRes = (await mcp.callTool({
      name: "tm1_search_tools",
      arguments: { access: "write" },
    })) as { structuredContent: { matches: Array<{ name: string }> } };
    expect(
      searchRes.structuredContent.matches.map((m) => m.name).sort(),
    ).toEqual([
      "tm1_create_sandbox",
      "tm1_delete_sandbox",
      "tm1_discard_sandbox",
      "tm1_write_cells",
    ]);

    await mcp.close();
    await server.close();
  });

  it("exposes 9 tools in readwrite mode and pins taskSupport tools with execution.taskSupport", async () => {
    const client = makeFakeClient();
    const registry = ConnectionRegistry.of([
      { name: "dev", client, mode: "readwrite" },
    ]);
    const server = buildMcpServer(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "search" }),
      mockLogger,
    );
    const mcp = await connectInMemory(server);
    const list = await mcp.listTools();
    const names = list.tools.map((t) => t.name);

    expect(names).toHaveLength(9);
    expect(names).toContain("tm1_execute_process");
    expect(names).toContain("tm1_execute_chore");
    expect(names).toContain("tm1_call_write_tool");

    const execProc = list.tools.find((t) => t.name === "tm1_execute_process");
    const execChore = list.tools.find((t) => t.name === "tm1_execute_chore");
    expect(execProc?.execution?.taskSupport).toBe("optional");
    expect(execChore?.execution?.taskSupport).toBe("optional");

    const callRead = list.tools.find((t) => t.name === "tm1_call_read_tool");
    const callWrite = list.tools.find((t) => t.name === "tm1_call_write_tool");
    expect(callRead?.annotations?.readOnlyHint).toBe(true);
    expect(callWrite?.annotations?.readOnlyHint).toBe(false);
    expect(callWrite?.annotations?.destructiveHint).toBe(true);

    await mcp.close();
    await server.close();
  });

  it("respects TM1_TOOLSETS when combined with search mode", async () => {
    const client = makeFakeClient();
    const registry = ConnectionRegistry.of([
      { name: "dev", client, mode: "readwrite" },
    ]);
    const server = buildMcpServer(
      registry,
      loadServerSettings({
        TM1_TOOL_DISCOVERY: "search",
        TM1_TOOLSETS: "analysis",
      }),
      mockLogger,
    );
    const mcp = await connectInMemory(server);
    const list = await mcp.listTools();
    // analysis has 0 write tools and excludes rest/celldata/scheduling/ti
    expect(list.tools.map((t) => t.name)).toEqual([
      "tm1_list_connections",
      "tm1_search_tools",
      "tm1_describe_tool",
      "tm1_call_read_tool",
    ]);
    await mcp.close();
    await server.close();
  });

  it("supports end-to-end search -> describe -> call_read / call_write and enforces read/write split", async () => {
    const cleared: string[] = [];
    const readRules: string[] = [];
    const client = makeFakeClient({
      onClearCube: (c) => cleared.push(c),
      onGetRules: (c) => readRules.push(c),
    });
    const registry = ConnectionRegistry.of([
      { name: "dev", client, mode: "readwrite" },
      { name: "prod", client, mode: "readonly" },
    ]);
    const server = buildMcpServer(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "search" }),
      mockLogger,
    );
    const mcp = await connectInMemory(server);

    // 1. Search
    const searchRes = (await mcp.callTool({
      name: "tm1_search_tools",
      arguments: { query: "get cube rules" },
    })) as {
      structuredContent: {
        matches: Array<{ name: string; callVia: string }>;
      };
    };
    expect(searchRes.structuredContent.matches[0]?.name).toBe(
      "tm1_get_cube_rules",
    );
    expect(searchRes.structuredContent.matches[0]?.callVia).toBe(
      "tm1_call_read_tool",
    );

    // 2. Describe (multi-connection -> includes `connection`)
    const descRes = (await mcp.callTool({
      name: "tm1_describe_tool",
      arguments: { toolName: "tm1_get_cube_rules" },
    })) as {
      structuredContent: {
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
        outputSchema?: unknown;
      };
    };
    expect(descRes.structuredContent.name).toBe("tm1_get_cube_rules");
    expect(descRes.structuredContent.inputSchema.properties).toHaveProperty(
      "connection",
    );
    expect(descRes.structuredContent.outputSchema).toBeUndefined();

    const descWithOut = (await mcp.callTool({
      name: "tm1_describe_tool",
      arguments: { toolName: "tm1_get_cube_rules", includeOutputSchema: true },
    })) as { structuredContent: { outputSchema?: unknown } };
    expect(descWithOut.structuredContent.outputSchema).toBeDefined();

    // 3. Call read tool via tm1_call_read_tool
    const readRes = (await mcp.callTool({
      name: "tm1_call_read_tool",
      arguments: {
        toolName: "tm1_get_cube_rules",
        arguments: { connection: "dev", cubeName: "Sales" },
      },
    })) as {
      isError?: boolean;
      structuredContent: { cubeName: string; rulesText: string };
    };
    expect(readRes.isError).toBeUndefined();
    expect(readRes.structuredContent.cubeName).toBe("Sales");
    expect(readRes.structuredContent.rulesText).toContain("SKIPCHECK");
    expect(readRules).toEqual(["Sales"]);

    // 4. Read/write split enforcement
    const writeViaRead = (await mcp.callTool({
      name: "tm1_call_read_tool",
      arguments: {
        toolName: "tm1_clear_cube",
        arguments: { connection: "dev", cubeName: "Sales", confirm: "Sales" },
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(writeViaRead.isError).toBe(true);
    expect(writeViaRead.content[0]?.text).toContain("PERMISSION_DENIED");
    expect(cleared).toEqual([]);

    const readViaWrite = (await mcp.callTool({
      name: "tm1_call_write_tool",
      arguments: {
        toolName: "tm1_get_cube_rules",
        arguments: { connection: "dev", cubeName: "Sales" },
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(readViaWrite.isError).toBe(true);
    expect(readViaWrite.content[0]?.text).toContain("VALIDATION_ERROR");

    // 5. Write tool via tm1_call_write_tool succeeds on readwrite connection
    const writeRes = (await mcp.callTool({
      name: "tm1_call_write_tool",
      arguments: {
        toolName: "tm1_clear_cube",
        arguments: { connection: "dev", cubeName: "Sales", confirm: "Sales" },
      },
    })) as { isError?: boolean; structuredContent: { success: boolean } };
    expect(writeRes.isError).toBeUndefined();
    expect(writeRes.structuredContent.success).toBe(true);
    expect(cleared).toEqual(["Sales"]);

    // 6. Meta-tool cannot be called recursively
    const recursive = (await mcp.callTool({
      name: "tm1_call_read_tool",
      arguments: { toolName: "tm1_search_tools", arguments: {} },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(recursive.isError).toBe(true);
    expect(recursive.content[0]?.text).toContain("NOT_FOUND");

    // 7. Direct call to non-pinned tool is rejected
    await expect(
      mcp.callTool({
        name: "tm1_get_cube_rules",
        arguments: { connection: "dev", cubeName: "Sales" },
      }),
    ).rejects.toThrow(/tm1_call_read_tool/);

    // 8. Inner strict validation error surfaces helpful hint
    const badArgs = (await mcp.callTool({
      name: "tm1_call_read_tool",
      arguments: {
        toolName: "tm1_get_cube_rules",
        arguments: { connection: "dev", cubeName: "Sales", bogus: 1 },
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(badArgs.isError).toBe(true);
    expect(badArgs.content[0]?.text).toContain("tm1_describe_tool");

    await mcp.close();
    await server.close();
  });

  it("works with TM1_RESPONSE_MODE=structured and caches full vs search separately", async () => {
    const client = makeFakeClient();
    const registry = ConnectionRegistry.single(client);
    const fullSurf = getCompiledToolSurface(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "full" }),
      mockLogger,
    );
    const searchSurf = getCompiledToolSurface(
      registry,
      loadServerSettings({ TM1_TOOL_DISCOVERY: "search" }),
      mockLogger,
    );
    expect(fullSurf).not.toBe(searchSurf);
    expect(fullSurf.discovery).toBe("full");
    expect(searchSurf.discovery).toBe("search");

    const server = buildMcpServer(
      registry,
      loadServerSettings({
        TM1_TOOL_DISCOVERY: "search",
        TM1_RESPONSE_MODE: "structured",
      }),
      mockLogger,
    );
    const mcp = await connectInMemory(server);
    const res = (await mcp.callTool({
      name: "tm1_search_tools",
      arguments: { query: "cube rules" },
    })) as { content: unknown[]; structuredContent: { returned: number } };
    expect(res.content).toEqual([]);
    expect(res.structuredContent.returned).toBeGreaterThan(0);

    await mcp.close();
    await server.close();
  });
});

describe("MCP Tasks preserved in TM1_TOOL_DISCOVERY=search over HTTP", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it("executes pinned tm1_execute_process as an async task in search mode", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });

    const fakeClient = {
      version: 11,
      processes: {
        startExecute: async () => ({
          mode: "async" as const,
          asyncId: "async-search-1",
          path: "/api/v1/Processes('P')/tm1.ExecuteWithReturn",
        }),
        pollExecute: async () => ({
          kind: "done" as const,
          result: {
            success: true,
            outcome: "succeeded" as const,
            processErrorStatus: "CompletedSuccessfully",
          },
        }),
      },
    } as unknown as TM1Client;

    const registry = ConnectionRegistry.of(
      [{ name: "default", client: fakeClient, mode: "readwrite" }],
      mockLogger,
    );
    const settings: ServerSettings = {
      ...loadServerSettings({ TM1_TOOL_DISCOVERY: "search" }),
      transport: "http",
      httpHost: "127.0.0.1",
      httpPort: port,
      httpAllowedOrigins: [],
      httpAllowedHosts: [],
    };
    const taskManager = new Tm1TaskManager(registry, settings, mockLogger);
    close = await startHttpTransport(
      () => buildMcpServer(registry, settings, mockLogger, taskManager),
      settings,
      mockLogger,
    );

    const startRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "tm1_execute_process",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tm1_execute_process",
          arguments: { processName: "P.Search", confirm: "P.Search" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [TASKS_EXTENSION_ID]: {} },
            },
          },
        },
      }),
    });
    const started = (await startRes.json()) as {
      result: { resultType: string; taskId: string };
    };
    expect(started.result.resultType).toBe("task");

    const pollRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tasks/get",
        "Mcp-Name": started.result.taskId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: {
          taskId: started.result.taskId,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [TASKS_EXTENSION_ID]: {} },
            },
          },
        },
      }),
    });
    const polled = (await pollRes.json()) as { result: { status: string } };
    expect(polled.result.status).toBe("completed");
  });
});
