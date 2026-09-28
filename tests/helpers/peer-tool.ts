// Drive a peer (two-connection) tool the way the SDK would: register it
// against a two-client registry, parse the input through its zod shape so
// defaults apply, and return the parsed JSON payload.
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { ConnectionRegistry } from "../../src/connections.js";
import type { ClientSource } from "../../src/tools/define-tool.js";

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

export function peerRunner(
  register: (server: McpServer, source: ClientSource) => void,
  clients: { dev: TM1Client; prod: TM1Client },
) {
  let schema: ZodRawShape | undefined;
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _desc: string, s: ZodRawShape, h: Handler) => {
      schema = s;
      handler = h;
    },
  } as unknown as McpServer;
  register(
    server,
    ConnectionRegistry.of([
      { name: "dev", client: clients.dev },
      { name: "prod", client: clients.prod },
    ]),
  );
  if (!schema || !handler) throw new Error("tool was not registered");
  const [s, h] = [schema, handler];
  return async <T = Record<string, unknown>>(
    input: Record<string, unknown>,
  ): Promise<T> => {
    const res = await h(z.object(s).parse(input), {});
    return JSON.parse(res.content[0].text) as T;
  };
}
