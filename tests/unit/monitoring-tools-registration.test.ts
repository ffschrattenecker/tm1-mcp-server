import { describe, it, expect } from "vitest";
import { registerGetJobs } from "../../src/tools/operations/get-jobs.js";
import { registerGetThreads } from "../../src/tools/operations/get-threads.js";
import { registerSaveData } from "../../src/tools/operations/save-data.js";
import { registerGetAuditLog } from "../../src/tools/operations/get-audit-log.js";
import { registerGetMessageLog } from "../../src/tools/operations/get-message-log.js";
import { registerGetTransactionLog } from "../../src/tools/operations/get-transaction-log.js";
import { registerUnloadCube } from "../../src/tools/model-building/unload-cube.js";
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

describe("version-gated monitoring tools", () => {
  it("v12 registers job tools and no thread tools", () => {
    const j = mockServer();
    registerGetJobs(j.server, clientWith(12));
    expect(j.names).toEqual(["tm1_list_jobs", "tm1_cancel_job"]);
    const t = mockServer();
    registerGetThreads(t.server, clientWith(12));
    expect(t.names).toEqual([]);
  });

  it("v11 registers thread tools and no job tools", () => {
    const t = mockServer();
    registerGetThreads(t.server, clientWith(11));
    expect(t.names).toEqual(["tm1_list_threads", "tm1_cancel_thread"]);
    const j = mockServer();
    registerGetJobs(j.server, clientWith(11));
    expect(j.names).toEqual([]);
  });

  // 12.5 answers POST Cubes('x')/tm1.Unload with "Demand load, loading and
  // unloading of cubes is no longer supported." — measured live. The feature
  // is gone with no successor, so the tool is not offered on v12 at all.
  it("registers tm1_unload_cube on v11 only (v12 dropped demand load)", () => {
    const v11 = mockServer();
    registerUnloadCube(v11.server, clientWith(11));
    expect(v11.names).toEqual(["tm1_unload_cube"]);
    const v12 = mockServer();
    registerUnloadCube(v12.server, clientWith(12));
    expect(v12.names).toEqual([]);
  });

  it("registers tm1_save_data on v11 only (v12 removed SaveDataAll/CubeSaveData)", () => {
    const v11 = mockServer();
    registerSaveData(v11.server, clientWith(11));
    expect(v11.names).toEqual(["tm1_save_data"]);
    const v12 = mockServer();
    registerSaveData(v12.server, clientWith(12));
    expect(v12.names).toEqual([]);
  });

  // v12 deprecated AuditLogEntry, MessageLogEntry and TransactionLogEntry in
  // 12.0.0. The collections still answer 200 but always empty, and there is no
  // successor endpoint — measured 2026-08-21 against 12.5.9 (0 rows) with
  // 11.8.02900.8 as control (37,655 message log rows). Serving an empty list
  // reads as "nothing happened", so the tools are gated off instead.
  it.each([
    ["tm1_get_audit_log", registerGetAuditLog],
    ["tm1_get_message_log", registerGetMessageLog],
    ["tm1_get_transaction_log", registerGetTransactionLog],
  ])(
    "registers %s on v11 only (v12 deprecated the log endpoint)",
    (name, register) => {
      const v11 = mockServer();
      register(v11.server, clientWith(11));
      expect(v11.names).toEqual([name]);
      const v12 = mockServer();
      register(v12.server, clientWith(12));
      expect(v12.names).toEqual([]);
    },
  );
});
