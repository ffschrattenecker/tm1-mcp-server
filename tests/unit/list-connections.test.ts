// tm1_list_connections is the only place a model sees every connection's
// environment label, so what reaches its output matters, not just what the
// registry knows. Driven through a real discovered registry, no TM1 contact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import pino from "pino";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { defineTool } from "../../src/tools/define-tool.js";
import { DESTRUCTIVE } from "../../src/tools/annotations.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerListConnections } from "../../src/tools/operations/list-connections.js";

const logger = pino({ level: "silent" });

function capture() {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  const tools = new Map<string, (...a: unknown[]) => unknown>();
  server.registerTool = ((...args: unknown[]) => {
    tools.set(args[0] as string, args[2] as (...a: unknown[]) => unknown);
    return {} as ReturnType<typeof server.registerTool>;
  }) as typeof server.registerTool;
  return { wrapped: withAnnotations(server, logger, "readwrite"), tools };
}

const text = (r: unknown) =>
  (r as { content: { text: string }[] }).content[0].text;

describe("tm1_list_connections", () => {
  let root: string;
  let registry: ConnectionRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tm1-listconn-"));
    for (const [name, env] of [
      ["dev", "dev"],
      ["prod", "prod"],
    ]) {
      mkdirSync(join(root, name));
      writeFileSync(
        join(root, name, ".env"),
        [
          `TM1_BASE_URL=http://${name}:1`,
          "TM1_USER=u",
          "TM1_PASSWORD=p",
          "TM1_MODE=readwrite",
          `TM1_ENVIRONMENT=${env}`,
        ].join("\n"),
      );
    }
    registry = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root },
      logger,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports each connection's environment and why prod is readonly", async () => {
    const { wrapped, tools } = capture();
    registerListConnections(wrapped, registry);

    const { connections } = JSON.parse(
      text(await tools.get("tm1_list_connections")!({})),
    );
    expect(connections).toEqual([
      {
        name: "dev",
        mode: "readwrite",
        environment: "dev",
        tm1Version: "11.8",
        connected: false,
      },
      {
        name: "prod",
        mode: "readonly",
        environment: "prod",
        modeReason: expect.stringMatching(/prod forces readonly/),
        tm1Version: "11.8",
        connected: false,
      },
    ]);
  });

  it("names the prod rule in a write tool's refusal", async () => {
    const { wrapped, tools } = capture();
    const handler = vi.fn(() => ({
      content: [{ type: "text" as const, text: "{}" }],
    }));
    defineTool({
      name: "tm1_spec_listconn_write",
      description: "fixture",
      annotations: DESTRUCTIVE,
      input: { cubeName: z.string() },
      handler,
    })(wrapped, registry);

    const refused = text(
      await tools.get("tm1_spec_listconn_write")!({
        cubeName: "C",
        connection: "prod",
      }),
    );
    expect(refused).toMatch(/PERMISSION_DENIED/);
    expect(refused).toMatch(/TM1_ALLOW_PROD_WRITES/);
    expect(handler).not.toHaveBeenCalled();
  });
});
