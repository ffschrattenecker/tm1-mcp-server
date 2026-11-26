#!/usr/bin/env node
import "./load-env.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type pino from "pino";
import { loadServerSettings } from "./config.js";
import { ConnectionRegistry } from "./connections.js";
import { buildMcpServer } from "./build-mcp-server.js";
import { createLogger } from "./logger.js";
import { startHttpTransport } from "./http-transport.js";
import { Tm1TaskManager } from "./tasks/tm1-task-manager.js";

// stdio transport: serves both 2026-07-28 and 2025-era MCP clients.
function startStdioTransport(
  buildServer: () => McpServer,
  logger: pino.Logger,
): () => Promise<void> {
  const handle = serveStdio(() => buildServer(), {
    onerror: (err) => {
      logger.error({ err }, "MCP stdio transport error");
    },
  });
  logger.info("MCP server listening on stdio");
  return async () => {
    await handle.close();
  };
}

async function main(): Promise<void> {
  // `tm1-mcp-server secrets …` manages keychain entries and exits; it never
  // starts the server.
  if (process.argv[2] === "secrets") {
    const { runSecretsCli } = await import("./secrets-cli.js");
    process.exit(await runSecretsCli(process.argv.slice(3), process.env));
  }

  const settings = loadServerSettings();
  const logger = createLogger(settings);

  logger.info("Starting TM1 MCP Server");

  // One registry for every configured connection (see ./connections.ts).
  // Clients are built lazily on first use, so startup costs no TM1 logins.
  const registry = ConnectionRegistry.fromEnvironment(process.env, logger);
  for (const c of registry.status()) {
    if (c.configError) {
      logger.warn(
        { connection: c.name, err: c.configError },
        "connection unusable",
      );
    } else {
      logger.info(
        {
          connection: c.name,
          mode: c.mode,
          environment: c.environment,
          version: c.tm1Version,
        },
        "connection configured",
      );
      if (c.modeReason) {
        logger.warn(
          { connection: c.name },
          `${c.modeReason} Write and destructive tools are refused on this connection.`,
        );
      }
    }
  }

  if (registry.isSingle) {
    void registry.get(undefined);
  }

  const taskManager = new Tm1TaskManager(registry, settings, logger);
  const buildServer = () =>
    buildMcpServer(registry, settings, logger, taskManager);

  const closer =
    settings.transport === "http"
      ? await startHttpTransport(buildServer, settings, logger)
      : startStdioTransport(buildServer, logger);
  logger.info(
    `MCP server configured (connections: ${registry.names.join(", ")}, transport: ${settings.transport})`,
  );

  // Graceful shutdown — ensure TM1 session is always cleaned up.
  let shuttingDown = false;
  const shutdown = async (signal?: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down TM1 MCP Server");
    try {
      await closer?.();
    } catch (err) {
      logger.error({ err }, "Error closing transport");
    }
    await registry.disconnectAll();
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGHUP", () => {
    void shutdown("SIGHUP");
  });

  if (settings.transport === "stdio") {
    process.stdin.on("end", () => {
      logger.info("stdin ended (parent process gone), shutting down");
      void shutdown("stdin-end");
    });
    process.stdin.on("close", () => {
      logger.info("stdin closed, shutting down");
      void shutdown("stdin-close");
    });
  }

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception, attempting cleanup");
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
  });
}

main().catch((err) => {
  console.error("Fatal error starting TM1 MCP Server:", err);
  process.exit(1);
});
