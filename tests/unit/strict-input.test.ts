// Unknown tool arguments are rejected, not silently dropped. The SDK wraps a
// raw input shape in a plain z.object, which strips unknown keys; a stray
// `query` on tm1_rest_read then ran an unfiltered GET three times. These tests
// go through a real in-memory MCP client, because the rejection happens in the
// SDK's argument validation, before any handler is reached.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { RestBody } from "../../src/tm1-client/services/rest-service.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { defineTool } from "../../src/tools/define-tool.js";
import { READ_ONLY } from "../../src/tools/annotations.js";
import { registerRestRead } from "../../src/tools/rest/rest-read.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { mockLogger } from "../helpers/client-harness.js";

// Fake client: records every REST call so a test can prove none was made.
function fakeClient() {
  const sent: string[] = [];
  const reply = async (): Promise<RestBody> => ({ kind: "empty" });
  const client = {
    version: 11,
    connectionId: "fake:1",
    rest: {
      get: async (path: string) => {
        sent.push(`GET ${path}`);
        return reply();
      },
      send: async (method: string, path: string) => {
        sent.push(`${method} ${path}`);
        return reply();
      },
    },
  } as unknown as TM1Client;
  return { client, sent };
}

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

// The text the client got back for a call. The SDK reports a rejected argument
// set as a tool result whose text carries the JSON-RPC error, not as a thrown
// error, so the message is read from the text.
async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return res.content.map((c) => c.text ?? "").join("\n");
}

describe("unknown tool arguments are rejected", () => {
  it("names the stray key and the accepted ones, and never reaches the handler", async () => {
    const { client: tm1, sent } = fakeClient();
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    registerRestRead(
      wrapped,
      ConnectionRegistry.of([
        { name: "dev", client: tm1 },
        { name: "prod", client: tm1 },
      ]),
    );
    const client = await connect(server);

    const text = await callText(client, "tm1_rest_read", {
      connection: "dev",
      path: "Dimensions",
      query: "$select=Name",
    });

    expect(text).toContain(`MCP error ${ErrorCode.InvalidParams}`);
    expect(text).toMatch(/Unknown parameter\(s\): query/);
    expect(text).toContain("Accepted: path, maxChars, connection.");
    expect(sent).toEqual([]);
    await client.close();
    await server.close();
  });

  it("still runs a call that uses only declared arguments", async () => {
    const { client: tm1, sent } = fakeClient();
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    registerRestRead(
      wrapped,
      ConnectionRegistry.of([
        { name: "dev", client: tm1 },
        { name: "prod", client: tm1 },
      ]),
    );
    const client = await connect(server);

    const text = await callText(client, "tm1_rest_read", {
      connection: "dev",
      path: "Dimensions",
    });

    expect(text).not.toContain("Unknown parameter");
    expect(sent).toEqual(["GET Dimensions"]);
    await client.close();
    await server.close();
  });

  it("says 'Accepted: none' for a tool that takes no arguments", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    let ran = false;
    defineTool({
      name: "tm1_spec_strict_none",
      description: "fixture",
      annotations: READ_ONLY,
      connectionless: true,
      input: {},
      handler: () => {
        ran = true;
        return { content: [{ type: "text" as const, text: "{}" }] };
      },
    })(wrapped, ConnectionRegistry.of([]));
    const client = await connect(server);

    const text = await callText(client, "tm1_spec_strict_none", { x: 1 });

    expect(text).toMatch(/Unknown parameter\(s\): x\. Accepted: none\./);
    expect(ran).toBe(false);
    await client.close();
    await server.close();
  });

  it("advertises additionalProperties: false in tools/list", async () => {
    const { client: tm1 } = fakeClient();
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    registerRestRead(
      wrapped,
      ConnectionRegistry.of([
        { name: "dev", client: tm1 },
        { name: "prod", client: tm1 },
      ]),
    );
    const client = await connect(server);

    const listing = await client.listTools();
    const tool = listing.tools.find((t) => t.name === "tm1_rest_read");
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    await client.close();
    await server.close();
  });
});
