import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { ServerSettings } from "./config.js";
import type { ConnectionRegistry } from "./connections.js";
import { serverInstructions } from "./server-instructions.js";
import { registerAllTools } from "./tools/index.js";
import { withAnnotations } from "./tools/with-annotations.js";
import { NAME, VERSION } from "./version.js";

// Build a fully-registered MCP server (tools). Called once for stdio, and once
// per request for the stateless HTTP transport — so the per-build logging is at
// debug to avoid per-request spam. Registration is pure in-memory wiring (no
// I/O); the connection registry is shared, not rebuilt.
//
// Capabilities are declared explicitly per MCP spec recommendation:
//   tools — NOT declared here. Declaring it makes the SDK install tools/list in
//     the constructor, before withAnnotations() can wrap it, so the schemas would
//     go out unslimmed. The SDK adds `tools: { listChanged: true }` itself on the
//     first registration.
//   logging — NOT auto-registered by the SDK; declaring it unlocks
//     server.sendLoggingMessage() (delivered on stdio; HTTP stateless has no
//     standing stream, so notifications are not pushed there).
export function buildMcpServer(
  registry: ConnectionRegistry,
  settings: ServerSettings,
  logger: pino.Logger,
): McpServer {
  const server = new McpServer(
    {
      name: NAME,
      version: VERSION,
    },
    {
      capabilities: {
        logging: {},
      },
      instructions: serverInstructions(registry),
    },
  );

  // Register all tools — wrap the server so each registration takes its
  // annotations from its defineTool spec without editing call sites. In readonly
  // mode the proxy silently drops write/destructive tools so they never appear
  // in the tool listing — no autoApprove lists needed. In sandbox mode the proxy
  // keeps only the sandboxScoped writes. With several connections, write tools
  // are listed when ANY connection is readwrite and refused per call against a
  // readonly or sandbox one (see defineTool).
  // An empty registry lists everything; each call is checked against its connection.
  const mode =
    registry.anyReadwrite || registry.usableNames.length === 0
      ? "readwrite"
      : registry.anySandbox
        ? "sandbox"
        : "readonly";
  registerAllTools(
    withAnnotations(
      server,
      logger,
      mode,
      settings.responseMode,
      settings.maxResponseChars,
    ),
    registry,
  );
  logger.debug(`All MCP tools registered (mode: ${mode})`);

  return server;
}
