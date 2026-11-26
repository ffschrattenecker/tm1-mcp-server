// DisableSandboxing through the MCP protocol. The sandbox tools stay listed
// whatever TM1 reports, because clients are lazy and a server can have several
// connections. A call on a server without sandboxes answers with the reason,
// so the caller learns what to fix rather than seeing a bare refusal.
import { describe, it, expect, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type pino from "pino";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerAllTools } from "../../src/tools/index.js";
import { ConnectionRegistry } from "../../src/connections.js";
import type { TM1Client } from "../../src/tm1-client.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

const SANDBOX_TOOLS = [
  "tm1_compare_sandbox",
  "tm1_create_sandbox",
  "tm1_delete_sandbox",
  "tm1_discard_sandbox",
  "tm1_list_sandboxes",
  "tm1_publish_sandbox",
];

// Stands in for TM1Client: the gates read only these fields, and list is the
// one sandbox call that needs a service.
const fakeClient = (sandboxingDisabled: boolean | undefined) => {
  const tm1 = {
    version: 11,
    mode: "readwrite",
    sandboxPrefix: "mcp-",
    sandboxingDisabled,
    sandboxes: { list: vi.fn(async () => []) },
  };
  return tm1;
};

async function connect(fake: ReturnType<typeof fakeClient>) {
  const tm1Client = fake as unknown as TM1Client;
  const server = new McpServer({ name: "t", version: "0" });
  const registry = ConnectionRegistry.of([
    { name: "default", client: tm1Client },
  ]);
  registerAllTools(withAnnotations(server, logger, "readwrite"), registry);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const listedSandboxTools = async () =>
    (await client.listTools()).tools
      .map((t) => t.name)
      .filter((n) => n.includes("sandbox"))
      .sort();
  return { client, listedSandboxTools };
}

const errorText = (res: unknown) =>
  (res as { content: { text: string }[] }).content[0].text;

describe("sandbox tools are listed whatever DisableSandboxing says", () => {
  it("lists all six while the setting is unknown, off or on", async () => {
    for (const value of [undefined, false, true]) {
      const { listedSandboxTools } = await connect(fakeClient(value));
      expect(await listedSandboxTools()).toEqual(SANDBOX_TOOLS);
    }
  });
});

describe("a call on a server with sandboxing off says why", () => {
  it.each([
    ["tm1_list_sandboxes", {}],
    ["tm1_create_sandbox", { sandboxName: "mcp-a" }],
    ["tm1_discard_sandbox", { sandboxName: "mcp-a", confirm: "mcp-a" }],
    ["tm1_delete_sandbox", { sandboxName: "mcp-a", confirm: "mcp-a" }],
    ["tm1_publish_sandbox", { sandboxName: "mcp-a", confirm: "mcp-a" }],
    [
      "tm1_compare_sandbox",
      { sandboxName: "mcp-a", mdx: "SELECT {} ON 0 FROM [Sales]" },
    ],
  ])(
    "%s answers the reason, naming DisableSandboxing=T",
    async (name, args) => {
      const tm1Client = fakeClient(true);
      const { client } = await connect(tm1Client);

      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBe(true);
      const payload = JSON.parse(errorText(res)) as {
        code: string;
        message: string;
        hint: string;
      };
      expect(payload.code).toBe("UNSUPPORTED_OPERATION");
      expect(payload.message).toContain(
        `${name} is unavailable on connection "default"`,
      );
      expect(payload.message).toContain("DisableSandboxing=T");
      expect(payload.hint).toContain("Retrying cannot succeed");
      expect(tm1Client.sandboxes.list).not.toHaveBeenCalled();
    },
  );

  it("runs again once TM1 reports the setting cleared", async () => {
    const tm1Client = fakeClient(true);
    const { client, listedSandboxTools } = await connect(tm1Client);

    const refused = await client.callTool({
      name: "tm1_list_sandboxes",
      arguments: {},
    });
    expect(refused.isError).toBe(true);

    tm1Client.sandboxingDisabled = false;
    expect(await listedSandboxTools()).toEqual(SANDBOX_TOOLS);
    const ok = await client.callTool({
      name: "tm1_list_sandboxes",
      arguments: {},
    });
    expect(ok.isError).toBeFalsy();
    expect(tm1Client.sandboxes.list).toHaveBeenCalledOnce();
  });

  it("leaves the other tools untouched", async () => {
    const { client } = await connect(fakeClient(true));
    expect((await client.listTools()).tools.length).toBeGreaterThan(50);
  });
});
