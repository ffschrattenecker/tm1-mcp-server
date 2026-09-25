import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAllResources,
  stateResourceUris,
} from "../../src/resources/index.js";
import { ConnectionRegistry } from "../../src/connections.js";
import type { TM1Client } from "../../src/tm1-client.js";

// The MCP resource surface has no per-request parameters, so unlike the tool
// path (tm1_get_process_code with maskSecrets=false) there is no opt-out —
// credential redaction must be unconditional. These tests pin that contract
// by capturing the registered read callbacks and invoking them directly.

type ReadCb = (
  uri: URL,
  vars?: Record<string, string | string[]>,
) => Promise<{
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}>;

function makeFakeServer(): {
  server: McpServer;
  readCallbacks: Map<string, ReadCb>;
} {
  const readCallbacks = new Map<string, ReadCb>();
  const server = {
    registerResource: (
      name: string,
      _uriOrTemplate: unknown,
      _meta: unknown,
      cb: ReadCb,
    ) => {
      readCallbacks.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, readCallbacks };
}

const ODBC_PASSWORD = "Sup3rSecret!";

function makeTM1Stub(): TM1Client {
  return contractCheckedClient({
    processes: {
      getCode: async () => ({
        prolog: `ODBCOpen('MyDSN', 'sa', '${ODBC_PASSWORD}');`,
        metadata: "sPwd = 'hunter2';",
        data: "",
        epilog: "",
      }),
    },
    server: {
      getInfo: async () => ({
        serverName: "testserver",
        productVersion: "11.8.0",
        dataDirectory: "C:\\TM1\\Data",
        extra: { Access: { LDAP: { Password: "ldap-secret" } } },
      }),
    },
  } as unknown as TM1Client);
}

describe("MCP resources – unconditional credential masking", () => {
  it("tm1://process/{name}/code masks the ODBC password and credential assignments", async () => {
    const { server, readCallbacks } = makeFakeServer();
    registerAllResources(server, makeTM1Stub());

    const cb = readCallbacks.get("process-code");
    expect(cb).toBeDefined();
    const result = await cb!(new URL("tm1://process/My.Proc/code"), {
      name: "My.Proc",
    });
    const text = result.contents[0].text;
    const payload = JSON.parse(text) as Record<string, string>;

    // The credential literals never leave the server unmasked …
    expect(text).not.toContain(ODBC_PASSWORD);
    expect(text).not.toContain("hunter2");
    expect(payload.prolog).toContain("'***'");
    expect(payload.metadata).toContain("'***'");
    // … while the non-secret parts of the call survive intact.
    expect(payload.prolog).toContain("ODBCOpen('MyDSN', 'sa'");
  });

  it("tm1://server/info projects identity fields and drops the raw config body", async () => {
    const { server, readCallbacks } = makeFakeServer();
    registerAllResources(server, makeTM1Stub());

    const cb = readCallbacks.get("server-info");
    expect(cb).toBeDefined();
    const result = await cb!(new URL("tm1://server/info"));
    const text = result.contents[0].text;
    const payload = JSON.parse(text) as Record<string, unknown>;

    expect(text).not.toContain("ldap-secret");
    expect(payload.extra).toBeUndefined();
    expect(payload.serverName).toBe("testserver");
    expect(payload.productVersion).toBe("11.8.0");
  });
});

describe("MCP resources with several connections", () => {
  it("namespaces every resource by connection and reads from that connection", async () => {
    const infoFor = (serverName: string) =>
      ({
        version: 11,
        connectionId: serverName,
        server: { getInfo: async () => ({ serverName }) },
      }) as unknown as TM1Client;
    const registered: Array<{ name: string; uri: unknown }> = [];
    const readCallbacks = new Map<string, ReadCb>();
    const server = {
      registerResource: (
        name: string,
        uri: unknown,
        _meta: unknown,
        cb: ReadCb,
      ) => {
        registered.push({ name, uri });
        readCallbacks.set(name, cb);
      },
    } as unknown as McpServer;

    const catalog = registerAllResources(
      server,
      ConnectionRegistry.of([
        { name: "dev", client: infoFor("dev-server") },
        { name: "prod", client: infoFor("prod-server") },
      ]),
    );

    expect(registered.filter((r) => typeof r.uri === "string")).toEqual([
      { name: "dev:server-info", uri: "tm1://dev/server/info" },
      { name: "dev:server-state", uri: "tm1://dev/server/state" },
      { name: "prod:server-info", uri: "tm1://prod/server/info" },
      { name: "prod:server-state", uri: "tm1://prod/server/state" },
    ]);
    expect(catalog.entries).toHaveLength(8);

    const result = await readCallbacks.get("prod:server-info")!(
      new URL("tm1://prod/server/info"),
    );
    expect(JSON.parse(result.contents[0].text)).toMatchObject({
      serverName: "prod-server",
    });
  });

  it("maps each connection's state URI to its connectionId", () => {
    const client = (id: string) =>
      ({ version: 11, connectionId: id }) as unknown as TM1Client;
    const uris = stateResourceUris(
      ConnectionRegistry.of([
        { name: "dev", client: client("h1_1") },
        { name: "prod", client: client("h2_1") },
      ]),
    );
    expect([...uris]).toEqual([
      ["tm1://dev/server/state", "h1_1"],
      ["tm1://prod/server/state", "h2_1"],
    ]);
  });
});
