// Memoized tool registry + pre-serialized slimmed `tools/list` payload.
//
// In stateless HTTP mode every incoming POST gets a fresh McpServer instance.
// Re-running 67 Zod -> JSON-Schema conversions + slimming on every HTTP request
// wastes CPU and allocations. This module compiles the tool surface ONCE per
// `(registry, registry.revision, mode, toolsets, responseMode, maxResponseChars)`
// and attaches cached `tools/list`, `tools/call`, and `tasks/*` handlers onto
// each McpServer in O(1).
import type pino from "pino";
import { z, type ZodRawShape } from "zod";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
  type McpServer,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server";
import type { ServerSettings } from "../config.js";
import type { ConnectionRegistry } from "../connections.js";
import {
  extractTraceContext,
  runWithTraceContext,
} from "../lib/trace-context.js";
import {
  TASKS_EXTENSION_ID,
  Tm1TaskManager,
} from "../tasks/tm1-task-manager.js";
import { extraHttpHeaders, extraMeta, extraSignal } from "./context.js";
import { registerAllTools } from "./index.js";
import { toolsetsCacheKey } from "./toolsets.js";
import {
  prepareToolRegistration,
  type PreparedToolRegistration,
  type ToolCallback,
} from "./with-annotations.js";

export interface CompiledTool {
  prepared: PreparedToolRegistration;
}

export interface CompiledToolSurface {
  revision: number;
  mode: "readwrite" | "sandbox" | "readonly";
  toolsListResult: { tools: Tool[] };
  toolsByName: ReadonlyMap<string, CompiledTool>;
}

const SURFACE_CACHE = new WeakMap<
  ConnectionRegistry,
  Map<string, CompiledToolSurface>
>();

const TASK_ID_PARAMS_SCHEMA = z.object({ taskId: z.string() });

export function modeForRegistry(
  registry: ConnectionRegistry,
): "readwrite" | "sandbox" | "readonly" {
  return registry.anyReadwrite || registry.usableNames.length === 0
    ? "readwrite"
    : registry.anySandbox
      ? "sandbox"
      : "readonly";
}

function compileSurface(
  registry: ConnectionRegistry,
  settings: ServerSettings,
  logger: pino.Logger,
): CompiledToolSurface {
  const mode = modeForRegistry(registry);
  const toolsByName = new Map<string, CompiledTool>();
  const listedTools: Tool[] = [];

  const collector = {
    registerTool(
      name: string,
      rawConfig: { description?: string; inputSchema?: ZodRawShape },
      rawCb: ToolCallback,
    ) {
      const prepared = prepareToolRegistration(
        name,
        rawConfig.description ?? "",
        rawConfig.inputSchema ?? {},
        rawCb,
        {
          logger,
          mode,
          responseMode: settings.responseMode,
          maxResponseChars: settings.maxResponseChars,
        },
      );
      if (!prepared) return undefined;
      toolsByName.set(name, { prepared });
      const inputJson = prepared.slimInputSchema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }) as Tool["inputSchema"];
      const toolDef: Tool = {
        name: prepared.name,
        title: prepared.title,
        description: prepared.description,
        inputSchema: inputJson,
        annotations: prepared.annotations,
        ...(prepared.taskSupport !== undefined
          ? { execution: { taskSupport: prepared.taskSupport } }
          : {}),
        ...(prepared.outputSchemaJson !== undefined
          ? { outputSchema: prepared.outputSchemaJson }
          : {}),
      };
      listedTools.push(toolDef);
      return undefined;
    },
  } as unknown as McpServer;

  registerAllTools(collector, registry, settings.toolsets);

  return {
    revision: registry.revision,
    mode,
    toolsListResult: { tools: listedTools },
    toolsByName,
  };
}

/**
 * Return the memoized `CompiledToolSurface` for `registry` and `settings`.
 * Automatically rebuilds whenever `registry.revision` advances (e.g. after
 * `ConnectionRegistry.refresh()` adds, removes, or reloads a folder).
 */
export function getCompiledToolSurface(
  registry: ConnectionRegistry,
  settings: ServerSettings,
  logger: pino.Logger,
): CompiledToolSurface {
  let bySettings = SURFACE_CACHE.get(registry);
  if (!bySettings) {
    bySettings = new Map();
    SURFACE_CACHE.set(registry, bySettings);
  }
  const key = `${modeForRegistry(registry)}|${toolsetsCacheKey(settings.toolsets)}|${settings.responseMode}|${settings.maxResponseChars}`;
  const cached = bySettings.get(key);
  if (cached && cached.revision === registry.revision) {
    return cached;
  }
  const compiled = compileSurface(registry, settings, logger);
  bySettings.set(key, compiled);
  return compiled;
}

/**
 * Attach a precompiled tool surface (and optional task manager) onto `server`.
 * O(1) per request — no per-tool Zod compilation or schema slimming.
 */
export function attachCompiledSurface(
  server: McpServer,
  surface: CompiledToolSurface,
  taskManager?: Tm1TaskManager,
): void {
  const lowLevel = server.server;
  lowLevel.registerCapabilities({
    tools: { listChanged: true },
    ...(taskManager
      ? {
          extensions: {
            [TASKS_EXTENSION_ID]: {},
          },
        }
      : {}),
  });

  lowLevel.setRequestHandler("tools/list", () => surface.toolsListResult);

  lowLevel.setRequestHandler(
    "tools/call",
    async (request, ctx: ServerContext) => {
      const toolName = request.params.name;
      const entry = surface.toolsByName.get(toolName);
      if (!entry) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${toolName} not found`,
        );
      }

      const validation = await entry.prepared.strictInput["~standard"].validate(
        request.params.arguments ?? {},
      );
      if ("issues" in validation && validation.issues) {
        const msg = validation.issues.map((i) => i.message).join("; ");
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Input validation error: Invalid arguments for tool ${toolName}: ${msg}`,
        );
      }

      const args = validation.value as Record<string, unknown>;
      const meta = extraMeta(ctx);
      const trace = extractTraceContext(meta, extraHttpHeaders(ctx));

      if (
        taskManager &&
        entry.prepared.taskSupport !== undefined &&
        (toolName === "tm1_execute_process" ||
          toolName === "tm1_execute_chore") &&
        Tm1TaskManager.clientSupportsTasks(meta, request.params)
      ) {
        const taskOrResult = await taskManager.startToolTask(
          toolName,
          args,
          trace,
        );
        if (
          "resultType" in taskOrResult &&
          taskOrResult.resultType === "task"
        ) {
          return taskOrResult as unknown as CallToolResult;
        }
        return lowLevel.projectCallToolResult(
          taskOrResult as CallToolResult,
          entry.prepared.outputSchemaJson,
        );
      }

      const result = (await runWithTraceContext(trace, () =>
        entry.prepared.wrappedCb(args, ctx),
      )) as CallToolResult;
      return lowLevel.projectCallToolResult(
        result,
        entry.prepared.outputSchemaJson,
      );
    },
  );

  if (taskManager) {
    lowLevel.setRequestHandler(
      "tasks/get",
      { params: TASK_ID_PARAMS_SCHEMA },
      async (params, ctx) => {
        const trace = extractTraceContext(
          extraMeta(ctx),
          extraHttpHeaders(ctx),
        );
        return taskManager.getTask(params.taskId, extraSignal(ctx), trace);
      },
    );

    lowLevel.setRequestHandler(
      "tasks/cancel",
      { params: TASK_ID_PARAMS_SCHEMA },
      async (params, ctx) => {
        const trace = extractTraceContext(
          extraMeta(ctx),
          extraHttpHeaders(ctx),
        );
        return taskManager.cancelTask(params.taskId, trace) as Promise<never>;
      },
    );
  }
}
