// Drive a peer (two-connection) tool the way the SDK would: register it
// against a two-client registry, parse the input through its zod shape so
// defaults apply, and return the parsed JSON payload.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { ConnectionRegistry } from "../../src/connections.js";
import type { ClientSource } from "../../src/tools/define-tool.js";
import { captureTool } from "./client-harness.js";

export function peerRunner(
  register: (server: McpServer, source: ClientSource) => void,
  clients: { dev: TM1Client; prod: TM1Client },
) {
  const { schema, cb } = captureTool(
    register,
    ConnectionRegistry.of([
      { name: "dev", client: clients.dev },
      { name: "prod", client: clients.prod },
    ]),
  );
  return async <T = Record<string, unknown>>(
    input: Record<string, unknown>,
  ): Promise<T> => {
    const res = await cb(z.object(schema).parse(input), {});
    return JSON.parse(res.content[0].text) as T;
  };
}
