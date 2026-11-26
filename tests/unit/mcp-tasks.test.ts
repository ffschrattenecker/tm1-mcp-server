import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import pino from "pino";
import { buildMcpServer } from "../../src/build-mcp-server.js";
import { loadServerSettings, type ServerSettings } from "../../src/config.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { startHttpTransport } from "../../src/http-transport.js";
import {
  Tm1TaskManager,
  TASKS_EXTENSION_ID,
} from "../../src/tasks/tm1-task-manager.js";
import type { TM1Client } from "../../src/tm1-client.js";

const silentLogger = pino({ level: "silent" });

const BASE_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

const TASK_CAP_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { [TASKS_EXTENSION_ID]: {} },
  },
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function makeSettings(port: number): ServerSettings {
  return {
    ...loadServerSettings({}),
    transport: "http",
    httpHost: "127.0.0.1",
    httpPort: port,
    httpAllowedOrigins: [],
    httpAllowedHosts: [],
  };
}

async function rpc(
  port: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const params = body.params as Record<string, unknown> | undefined;
  const nameOrTask =
    typeof params?.name === "string"
      ? params.name
      : typeof params?.taskId === "string"
        ? params.taskId
        : undefined;
  const mcpName = nameOrTask ? { "Mcp-Name": nameOrTask } : {};
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": String(body.method ?? ""),
      ...mcpName,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe("io.modelcontextprotocol/tasks over stateless HTTP", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it("runs tm1_execute_process and tm1_execute_chore via /_async task handles", async () => {
    let processPollCount = 0;
    const cancelledIds: string[] = [];

    const fakeClient = {
      version: 11,
      processes: {
        execute: async () => ({
          success: true,
          outcome: "succeeded" as const,
          processErrorStatus: "CompletedSuccessfully",
        }),
        startExecute: async (name: string) => ({
          mode: "async" as const,
          asyncId:
            name === "P.FailCancel" ? "async-proc-cancel" : "async-proc-1",
          path: "/api/v1/Processes('P')/tm1.ExecuteWithReturn?$expand=ErrorLogFile",
        }),
        pollExecute: async () => {
          processPollCount += 1;
          if (processPollCount === 1) {
            return { kind: "working" as const };
          }
          return {
            kind: "done" as const,
            result: {
              success: true,
              outcome: "succeeded" as const,
              processErrorStatus: "CompletedSuccessfully",
            },
          };
        },
        cancelExecute: async (asyncId: string) => {
          cancelledIds.push(asyncId);
        },
      },
      chores: {
        execute: async () => ({
          success: true,
          choreName: "C.Run",
          outcome: "succeeded" as const,
        }),
        startExecute: async () => ({
          mode: "async" as const,
          asyncId: "async-chore-1",
          path: "/api/v1/Chores('C.Run')/tm1.Execute",
        }),
        pollExecute: async () => ({
          kind: "done" as const,
          result: {
            success: true,
            choreName: "C.Run",
            outcome: "succeeded" as const,
          },
        }),
        cancelExecute: async (asyncId: string) => {
          cancelledIds.push(asyncId);
        },
      },
    } as unknown as TM1Client;

    const registry = ConnectionRegistry.of(
      [{ name: "default", client: fakeClient, mode: "readwrite" }],
      silentLogger,
    );
    const port = await freePort();
    const settings = makeSettings(port);
    const taskManager = new Tm1TaskManager(registry, settings, silentLogger);
    close = await startHttpTransport(
      () => buildMcpServer(registry, settings, silentLogger, taskManager),
      settings,
      silentLogger,
    );

    // 1. server/discover advertises io.modelcontextprotocol/tasks extension
    const disc = await rpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: BASE_META },
    });
    expect(disc.status).toBe(200);
    const caps = (
      disc.json.result as {
        capabilities?: { extensions?: Record<string, unknown> };
      }
    ).capabilities;
    expect(caps?.extensions?.[TASKS_EXTENSION_ID]).toBeDefined();

    // 2. Synchronous fallback when client does NOT advertise tasks capability
    const syncCall = await rpc(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tm1_execute_process",
        arguments: { processName: "P.Sync", confirm: "P.Sync" },
        _meta: BASE_META,
      },
    });
    expect(syncCall.status).toBe(200);
    const syncResult = syncCall.json.result as {
      resultType?: string;
      content?: Array<{ text: string }>;
    };
    expect(syncResult.resultType).toBe("complete");
    expect(syncResult.content?.[0].text).toContain("CompletedSuccessfully");

    // 3. Task-augmented call returns task handle immediately
    const startProc = await rpc(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tm1_execute_process",
        arguments: { processName: "P.Async", confirm: "P.Async" },
        _meta: TASK_CAP_META,
      },
    });
    expect(startProc.status).toBe(200);
    const started = startProc.json.result as {
      resultType: string;
      taskId: string;
      status: string;
    };
    expect(started.resultType).toBe("task");
    expect(started.status).toBe("working");

    // 4. First tasks/get stays working, second resolves completed with result
    const poll1 = await rpc(port, {
      jsonrpc: "2.0",
      id: 4,
      method: "tasks/get",
      params: { taskId: started.taskId, _meta: TASK_CAP_META },
    });
    expect(poll1.status).toBe(200);
    expect((poll1.json.result as { status: string }).status).toBe("working");

    const poll2 = await rpc(port, {
      jsonrpc: "2.0",
      id: 5,
      method: "tasks/get",
      params: { taskId: started.taskId, _meta: TASK_CAP_META },
    });
    expect(poll2.status).toBe(200);
    const completed = poll2.json.result as {
      status: string;
      result?: { content?: Array<{ text: string }> };
    };
    expect(completed.status).toBe("completed");
    expect(completed.result?.content?.[0].text).toContain(
      "CompletedSuccessfully",
    );

    // 5. Chore task execution completes too
    const startChore = await rpc(port, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "tm1_execute_chore",
        arguments: { choreName: "C.Run", confirm: "C.Run" },
        _meta: TASK_CAP_META,
      },
    });
    const choreTaskId = (startChore.json.result as { taskId: string }).taskId;
    const choreDone = await rpc(port, {
      jsonrpc: "2.0",
      id: 7,
      method: "tasks/get",
      params: { taskId: choreTaskId, _meta: TASK_CAP_META },
    });
    expect((choreDone.json.result as { status: string }).status).toBe(
      "completed",
    );

    // 6. tasks/cancel forwards DELETE to TM1 _async handle and marks cancelled
    const startCancel = await rpc(port, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "tm1_execute_process",
        arguments: { processName: "P.FailCancel", confirm: "P.FailCancel" },
        _meta: TASK_CAP_META,
      },
    });
    const cancelTaskId = (startCancel.json.result as { taskId: string }).taskId;
    const cancelled = await rpc(port, {
      jsonrpc: "2.0",
      id: 9,
      method: "tasks/cancel",
      params: { taskId: cancelTaskId, _meta: TASK_CAP_META },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelledIds).toContain("async-proc-cancel");

    const afterCancel = await rpc(port, {
      jsonrpc: "2.0",
      id: 10,
      method: "tasks/get",
      params: { taskId: cancelTaskId, _meta: TASK_CAP_META },
    });
    expect((afterCancel.json.result as { status: string }).status).toBe(
      "cancelled",
    );
  });
});
