// MCP Tasks extension (`io.modelcontextprotocol/tasks`) backed by TM1's
// `/_async('id')` handles for `tm1_execute_process` and `tm1_execute_chore`.
//
// Why this matters over stateless HTTP: a long-running TI process or chore
// returns a durable MCP task handle (`resultType: "task", status: "working"`)
// backed by TM1's server-side `/_async('id')` operation, and subsequent
// `tasks/get` / `tasks/cancel` POSTs poll or cancel that TM1 operation without
// pinning an HTTP request open for minutes.
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ServerSettings } from "../config.js";
import type { ConnectionRegistry } from "../connections.js";
import { maskSecretValues } from "../lib/mask-secrets.js";
import {
  runWithTraceContext,
  traceLogBindings,
  type TraceContext,
} from "../lib/trace-context.js";
import { requireConfirm } from "../tools/confirm.js";
import {
  formatTm1ErrorResult,
  type McpToolResult,
} from "../tools/error-format.js";
import {
  narrowingHint,
  postProcessToolResult,
} from "../tools/with-annotations.js";
import { specFor } from "../tools/define-tool.js";
import { formatChoreExecutionResult } from "../tools/scheduling/execute-chore.js";
import { formatProcessExecutionResult } from "../tools/ti-development/execute-process.js";
import { TM1Error, TM1ErrorCode } from "../types.js";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

const DEFAULT_TASK_TTL_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface CreateTaskResult {
  resultType: "task";
  taskId: string;
  status: "working";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export type GetTaskResult =
  | {
      resultType: "complete";
      taskId: string;
      status: "working";
      statusMessage?: string;
      createdAt: string;
      lastUpdatedAt: string;
      ttlMs: number | null;
      pollIntervalMs?: number;
    }
  | {
      resultType: "complete";
      taskId: string;
      status: "completed";
      result: McpToolResult;
      statusMessage?: string;
      createdAt: string;
      lastUpdatedAt: string;
      ttlMs: number | null;
      pollIntervalMs?: number;
    }
  | {
      resultType: "complete";
      taskId: string;
      status: "failed";
      error: { code: number; message: string };
      statusMessage?: string;
      createdAt: string;
      lastUpdatedAt: string;
      ttlMs: number | null;
      pollIntervalMs?: number;
    }
  | {
      resultType: "complete";
      taskId: string;
      status: "cancelled";
      statusMessage?: string;
      createdAt: string;
      lastUpdatedAt: string;
      ttlMs: number | null;
      pollIntervalMs?: number;
    };

export interface CancelTaskResult {
  resultType: "complete";
}

type TaskKind =
  | {
      toolName: "tm1_execute_process";
      targetName: string;
    }
  | {
      toolName: "tm1_execute_chore";
      targetName: string;
      withReturn: boolean;
    };

interface TaskEntry {
  taskId: string;
  kind: TaskKind;
  connectionName: string;
  asyncId: string;
  path: string;
  status: "working" | "completed" | "failed" | "cancelled";
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  expiresAt: number;
  pollIntervalMs: number;
  result?: McpToolResult;
  error?: { code: number; message: string };
  trace?: TraceContext;
}

export class Tm1TaskManager {
  private readonly tasks = new Map<string, TaskEntry>();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly settings: ServerSettings,
    private readonly logger: pino.Logger,
  ) {}

  /** True if the client declared support for `io.modelcontextprotocol/tasks`. */
  static clientSupportsTasks(
    meta: Record<string, unknown> | undefined,
    params: Record<string, unknown> | undefined,
  ): boolean {
    if (params && "task" in params && params.task !== undefined) {
      return true;
    }
    const caps = meta?.["io.modelcontextprotocol/clientCapabilities"];
    if (!caps || typeof caps !== "object") return false;
    const exts = (caps as { extensions?: unknown }).extensions;
    if (!exts || typeof exts !== "object") return false;
    return TASKS_EXTENSION_ID in (exts as Record<string, unknown>);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.tasks) {
      if (now >= entry.expiresAt) {
        this.tasks.delete(id);
      }
    }
  }

  private gateConnection(toolName: string, connection: string | undefined) {
    const info = this.registry.resolveInfo(connection);
    const spec = specFor(toolName);
    if (spec && !spec.annotations.readOnlyHint && info.mode === "readonly") {
      throw new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message: `${toolName} changes TM1, but connection "${info.name}" is readonly.`,
        hint:
          info.modeReason ??
          "Set TM1_MODE=readwrite in that connection's .env to allow writes.",
      });
    }
    if (
      spec &&
      !spec.annotations.readOnlyHint &&
      info.mode === "sandbox" &&
      !spec.sandboxScoped
    ) {
      throw new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message: `${toolName} changes TM1 outside a sandbox, but connection "${info.name}" is in sandbox mode.`,
        hint:
          info.modeReason ??
          "Set TM1_MODE=readwrite in that connection's .env to allow writes outside sandboxes.",
      });
    }
    return info;
  }

  private finalizeToolResult(
    toolName: string,
    raw: McpToolResult,
  ): McpToolResult {
    const spec = specFor(toolName);
    const processed = postProcessToolResult(toolName, raw, {
      outputSchema: spec?.outputSchema,
      responseMode: this.settings.responseMode,
      maxResponseChars: this.settings.maxResponseChars,
      sizeHint: narrowingHint(new Set()),
      logger: this.logger,
    });
    return processed ?? raw;
  }

  /**
   * Start `tm1_execute_process` or `tm1_execute_chore` as a task backed by
   * TM1 `/_async('id')`. Returns a `CreateTaskResult` when TM1 replies 202,
   * or an immediate `McpToolResult` when TM1 finishes synchronously.
   */
  async startToolTask(
    toolName: "tm1_execute_process" | "tm1_execute_chore",
    args: Record<string, unknown>,
    trace?: TraceContext,
  ): Promise<CreateTaskResult | McpToolResult> {
    this.pruneExpired();
    const callLogger = this.logger.child({
      tool: toolName,
      ...traceLogBindings(trace),
    });

    return runWithTraceContext(trace, async () => {
      try {
        const connection = args.connection as string | undefined;
        const info = this.gateConnection(toolName, connection);
        const client = await this.registry.get(info.name);
        const timeoutMs =
          typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        const ttlMs = timeoutMs ?? DEFAULT_TASK_TTL_MS;

        if (toolName === "tm1_execute_process") {
          const processName = args.processName as string;
          const parameters = args.parameters as
            Record<string, string | number> | undefined;
          const confirm = args.confirm as string;
          requireConfirm(confirm, processName, "process");

          const started = await client.processes.startExecute(
            processName,
            parameters,
          );
          if (started.kind === "completed") {
            const raw = await formatProcessExecutionResult(
              started.result,
              client,
            );
            return this.finalizeToolResult(toolName, raw);
          }

          return this.recordWorkingTask({
            kind: { toolName, targetName: processName },
            connectionName: info.name,
            asyncId: started.asyncId,
            path: started.path,
            statusMessage: `Executing TI process '${processName}'`,
            ttlMs,
            trace,
          });
        }

        // tm1_execute_chore
        const choreName = args.choreName as string;
        const confirm = args.confirm as string;
        requireConfirm(confirm, choreName, "chore");

        const started = await client.chores.startExecute(choreName);
        if (started.kind === "completed") {
          const raw = formatChoreExecutionResult(started.result);
          return this.finalizeToolResult(toolName, raw);
        }

        return this.recordWorkingTask({
          kind: {
            toolName,
            targetName: choreName,
            withReturn: started.withReturn,
          },
          connectionName: info.name,
          asyncId: started.asyncId,
          path: started.path,
          statusMessage: `Executing TM1 chore '${choreName}'`,
          ttlMs,
          trace,
        });
      } catch (err) {
        callLogger.error({ err, tool: toolName }, "Task start failed");
        return formatTm1ErrorResult(err);
      }
    });
  }

  private recordWorkingTask(input: {
    kind: TaskKind;
    connectionName: string;
    asyncId: string;
    path: string;
    statusMessage: string;
    ttlMs: number;
    trace?: TraceContext | undefined;
  }): CreateTaskResult {
    const taskId = randomUUID();
    const nowIso = new Date().toISOString();
    const entry: TaskEntry = {
      taskId,
      kind: input.kind,
      connectionName: input.connectionName,
      asyncId: input.asyncId,
      path: input.path,
      status: "working",
      statusMessage: input.statusMessage,
      createdAt: nowIso,
      lastUpdatedAt: nowIso,
      ttlMs: input.ttlMs,
      expiresAt: Date.now() + input.ttlMs,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      ...(input.trace ? { trace: input.trace } : {}),
    };
    this.tasks.set(taskId, entry);
    return {
      resultType: "task",
      taskId,
      status: "working",
      statusMessage: entry.statusMessage,
      createdAt: entry.createdAt,
      lastUpdatedAt: entry.lastUpdatedAt,
      ttlMs: entry.ttlMs,
      pollIntervalMs: entry.pollIntervalMs,
    };
  }

  async getTask(
    taskId: string,
    signal?: AbortSignal,
    trace?: TraceContext,
  ): Promise<GetTaskResult> {
    this.pruneExpired();
    const entry = this.tasks.get(taskId);
    if (!entry) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown or expired task: ${taskId}`,
      );
    }

    if (entry.status !== "working") {
      return this.snapshot(entry);
    }

    const activeTrace = trace ?? entry.trace;
    return runWithTraceContext(activeTrace, async () => {
      try {
        const client = await this.registry.get(entry.connectionName);
        if (entry.kind.toolName === "tm1_execute_process") {
          const polled = await client.processes.pollExecute(
            entry.asyncId,
            entry.path,
            signal ? { signal } : undefined,
          );
          if (polled.kind === "working") {
            entry.lastUpdatedAt = new Date().toISOString();
            return this.snapshot(entry);
          }
          const raw = await formatProcessExecutionResult(polled.result, client);
          entry.result = this.finalizeToolResult(entry.kind.toolName, raw);
          entry.status = "completed";
          entry.statusMessage = `Completed TI process '${entry.kind.targetName}'`;
          entry.lastUpdatedAt = new Date().toISOString();
          return this.snapshot(entry);
        }

        const polled = await client.chores.pollExecute(
          entry.asyncId,
          entry.path,
          entry.kind.withReturn,
          signal ? { signal } : undefined,
        );
        if (polled.kind === "working") {
          entry.lastUpdatedAt = new Date().toISOString();
          return this.snapshot(entry);
        }
        const raw = formatChoreExecutionResult(polled.result);
        entry.result = this.finalizeToolResult(entry.kind.toolName, raw);
        entry.status = "completed";
        entry.statusMessage = `Completed TM1 chore '${entry.kind.targetName}'`;
        entry.lastUpdatedAt = new Date().toISOString();
        return this.snapshot(entry);
      } catch (err) {
        const msg = maskSecretValues(
          err instanceof Error ? err.message : String(err),
        );
        entry.status = "failed";
        entry.error = { code: ProtocolErrorCode.InternalError, message: msg };
        entry.statusMessage = msg;
        entry.lastUpdatedAt = new Date().toISOString();
        return this.snapshot(entry);
      }
    });
  }

  async cancelTask(
    taskId: string,
    trace?: TraceContext,
  ): Promise<CancelTaskResult> {
    this.pruneExpired();
    const entry = this.tasks.get(taskId);
    if (!entry) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown or expired task: ${taskId}`,
      );
    }
    if (entry.status === "cancelled") {
      return { resultType: "complete" };
    }
    if (entry.status !== "working") {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Cannot cancel task '${taskId}' in terminal status '${entry.status}'`,
      );
    }

    const activeTrace = trace ?? entry.trace;
    return runWithTraceContext(activeTrace, async () => {
      const client = await this.registry.get(entry.connectionName);
      const cancelled =
        entry.kind.toolName === "tm1_execute_process"
          ? await client.processes.cancelExecute(entry.asyncId, entry.path)
          : await client.chores.cancelExecute(entry.asyncId, entry.path);
      entry.status = "cancelled";
      entry.statusMessage = cancelled
        ? `Cancelled '${entry.kind.targetName}' on TM1`
        : `Cancel requested for '${entry.kind.targetName}' on TM1`;
      entry.lastUpdatedAt = new Date().toISOString();
      return { resultType: "complete" };
    });
  }

  private snapshot(entry: TaskEntry): GetTaskResult {
    const base = {
      resultType: "complete" as const,
      taskId: entry.taskId,
      statusMessage: entry.statusMessage,
      createdAt: entry.createdAt,
      lastUpdatedAt: entry.lastUpdatedAt,
      ttlMs: entry.ttlMs,
      pollIntervalMs: entry.pollIntervalMs,
    };
    switch (entry.status) {
      case "working":
        return { ...base, status: "working" };
      case "completed":
        return { ...base, status: "completed", result: entry.result! };
      case "failed":
        return { ...base, status: "failed", error: entry.error! };
      case "cancelled":
        return { ...base, status: "cancelled" };
    }
  }
}
