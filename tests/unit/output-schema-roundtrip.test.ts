// Branches of a tool that return a shape the declared outputSchema does not
// allow only fail at the protocol boundary: the SDK (and our drift guard)
// rejects the payload and the client sees isError. A schema-only test cannot
// catch that, so these calls go through a real in-memory MCP client.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import type { ToolRegistrar } from "../../src/tools/define-tool.js";
import { registerListErrorLogs } from "../../src/tools/operations/list-error-logs.js";
import { mockLogger } from "../helpers/client-harness.js";

async function call(
  register: ToolRegistrar,
  tm1Client: unknown,
  name: string,
  args: Record<string, unknown>,
) {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  register(
    withAnnotations(server, mockLogger, "readwrite"),
    tm1Client as TM1Client,
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  // A real client lists tools first; only then does the SDK client hold the
  // published outputSchema and validate structuredContent against it.
  await client.listTools();
  return client.callTool({ name, arguments: args });
}

describe("output schema round-trip", () => {
  it("tm1_list_error_logs groupBy='process' passes its own schema", async () => {
    const tm1 = {
      server: {
        listErrorLogFiles: () =>
          Promise.resolve([
            {
              filename: "TM1ProcessError_20260901120000_123_Load.Data_ab12.log",
            },
            {
              filename: "TM1ProcessError_20260902120000_124_Load.Data_cd34.log",
            },
          ]),
      },
    };
    const res = await call(registerListErrorLogs, tm1, "tm1_list_error_logs", {
      groupBy: "process",
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      groupBy: "process",
      totalFiles: 2,
    });
  });
});
