import { McpServer } from "@modelcontextprotocol/server";
import type pino from "pino";
import type { ServerSettings } from "./config.js";
import type { ConnectionRegistry } from "./connections.js";
import { serverInstructions } from "./server-instructions.js";
import { Tm1TaskManager } from "./tasks/tm1-task-manager.js";
import {
  attachCompiledSurface,
  getCompiledToolSurface,
} from "./tools/compiled-surface.js";
import { NAME, VERSION } from "./version.js";

// Build an MCP server backed by the memoized tool surface. Called once for
// stdio, and once per request for stateless HTTP — `getCompiledToolSurface`
// caches the pre-serialized slimmed tools/list payload per registry revision
// so per-request server construction is O(1).
export function buildMcpServer(
  registry: ConnectionRegistry,
  settings: ServerSettings,
  logger: pino.Logger,
  taskManager: Tm1TaskManager = new Tm1TaskManager(registry, settings, logger),
): McpServer {
  const surface = getCompiledToolSurface(registry, settings, logger);
  const server = new McpServer(
    {
      name: NAME,
      version: VERSION,
    },
    {
      instructions: serverInstructions(registry, {
        toolDiscovery: settings.toolDiscovery,
        hasWriteTools: surface.searchProjection?.hasWriteTools ?? false,
      }),
    },
  );

  attachCompiledSurface(server, surface, taskManager);
  logger.debug(
    `All MCP tools attached (mode: ${surface.mode}, discovery: ${surface.discovery}, tools: ${surface.toolsListResult.tools.length})`,
  );

  return server;
}
