#!/usr/bin/env node
import "./load-env.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type pino from "pino";
import { loadServerSettings } from "./config.js";
import { ConnectionRegistry } from "./connections.js";
import { buildMcpServer } from "./build-mcp-server.js";
import { createLogger } from "./logger.js";
import { startHttpTransport } from "./http-transport.js";

// stdio transport: existing Claude-Code/Desktop entry path.
async function startStdioTransport(
  server: McpServer,
  logger: pino.Logger,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server listening on stdio");
  return async () => {
    await transport.close();
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

  // A single connection logs in at startup, in the background: request()
  // re-authenticates on every call anyway, so a failed login here only delays
  // the error to the first tool call.
  if (registry.isSingle) {
    void registry.get(undefined);
  }

  // Branch on transport. stdio is the default for local MCP-client setups
  // (Claude Code, Claude Desktop) and gets one long-lived server. http
  // (Streamable HTTP, stateless) is for remote/multi-client deploys and builds a
  // fresh server per request (single-use transport); binds to 127.0.0.1 by
  // default with DNS-rebinding protection per MCP spec recommendation.
  const httpCloser =
    settings.transport === "http"
      ? await startHttpTransport(
          () => buildMcpServer(registry, settings, logger),
          settings,
          logger,
        )
      : await startStdioTransport(
          buildMcpServer(registry, settings, logger),
          logger,
        );
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
      await httpCloser?.();
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

  // Parent process death — only meaningful on stdio (Claude spawns us as a
  // child). For http we ignore stdin events since the process lifecycle is
  // independent.
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

  // Last resort — try to clean up the TM1 session on uncaught errors.
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception, attempting cleanup");
    // Exit non-zero: a crash must not look like a clean shutdown to a
    // supervisor/systemd, which would otherwise not restart or would mask it.
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
