import { describe, it, expect } from "vitest";
import { registerSaveData } from "../../src/tools/operations/save-data.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";

function mockServer() {
  const names: string[] = [];
  const server = {
    tool: (name: string) => void names.push(name),
  } as unknown as McpServer;
  return { server, names };
}
const clientWith = (version: 11 | 12) =>
  ({ version, monitoring: {}, server: {} }) as unknown as TM1Client;

describe("version-gated tools", () => {
  it("registers tm1_save_data on v11 only (v12 removed SaveDataAll/CubeSaveData)", () => {
    const v11 = mockServer();
    registerSaveData(v11.server, clientWith(11));
    expect(v11.names).toEqual(["tm1_save_data"]);
    const v12 = mockServer();
    registerSaveData(v12.server, clientWith(12));
    expect(v12.names).toEqual([]);
  });
});
