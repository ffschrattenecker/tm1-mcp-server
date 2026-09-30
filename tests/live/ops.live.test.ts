// Live integration: OPERATIONS / MONITORING / SECURITY / FILES domains.
//
// Drives the real MCP tool layer (zod schema -> withAnnotations -> handler ->
// TM1Client -> OData) against a running TM1 11.8 server, exactly as an MCP
// client would. Read-tier calls assert no error + plausible shape (NOT
// non-emptiness — an idle server returns empty thread/session/log arrays).
// Monitoring and security reads go through tm1_rest_read, the paths the
// prompts and hints name.
//
// Safe lifecycle exercised end-to-end under the SANDBOX prefix:
//   - FILE: upload -> read back -> delete.
// Nothing touches clients or groups: security writes on a shared server are
// out of scope for the live suite.
//
// Deliberately AVOIDED: an unbounded TransactionLogEntries scan (full-scan
// timeout trap) and tm1_save_data (global flush).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  restGet,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const PREFIX = `${SANDBOX}_OPS`;
const FILE_NAME = `${PREFIX}_FILE.txt`;
const FILE_BODY = `${PREFIX} synthetic live-test blob\nline2\nline3\n`;

describe.skipIf(!LIVE_ENABLED)(
  "live: ops / monitoring / security / files",
  () => {
    let h: LiveHarness;

    beforeAll(async () => {
      h = await getHarness();
    });

    afterAll(async () => {
      // Idempotent: the file may already be gone.
      await h.call("tm1_files_write", {
        op: "delete",
        fileName: FILE_NAME,
        confirm: FILE_NAME,
      });
    });

    // ---- VERSION GATE ------------------------------------------------------

    // tm1_save_data is registered per server version (`enabled:` in its
    // defineTool spec): v12 removed SaveDataAll/CubeSaveData. This asserts the
    // gate from both sides against the real server.
    it("registers tm1_save_data on v11 only", () => {
      expect(h.has("tm1_save_data")).toBe(h.client.version === 11);
    });

    // ---- OPERATIONS / MONITORING (read-tier) -------------------------------

    it("reads the product version from Configuration", async () => {
      const cfg = await restGet<{ ProductVersion?: string }>(
        h,
        "Configuration?$select=ProductVersion",
      );
      expect(cfg.ProductVersion).toMatch(/\d+\.\d+/);
    });

    it("tm1_get_server_state returns health snapshot", async () => {
      const r = await h.ok("tm1_get_server_state");
      expect(r.json).toMatchObject({
        connected: expect.any(Boolean),
        counts: expect.any(Object),
      });
      // Counts buckets are { count: number|null }.
      expect(r.json.counts).toHaveProperty("cubes");
      expect(r.json.counts).toHaveProperty("dimensions");
    });

    it("reads the newest message-log entries (v11)", async (ctx) => {
      if (h.client.version === 12) ctx.skip("v12 serves the log empty");
      const rows = await restGet<unknown[]>(
        h,
        "MessageLogEntries?$orderby=TimeStamp desc&$top=5",
      );
      expect(rows.length).toBeLessThanOrEqual(5);
    });

    // v12 deprecated the log collections in 12.0.0: they still answer 200,
    // always empty. An empty result there means "no data", not "nothing
    // happened".
    it("v12 answers the log collections empty", async (ctx) => {
      if (h.client.version !== 12) ctx.skip("v11 serves the logs");
      for (const coll of [
        "MessageLogEntries",
        "AuditLogEntries",
        "TransactionLogEntries",
      ]) {
        expect(await restGet<unknown[]>(h, `${coll}?$top=1`), coll).toEqual([]);
      }
    });

    it("reads threads (v11) or jobs (v12)", async () => {
      const rows = await restGet<unknown[]>(
        h,
        h.client.version === 12
          ? "Jobs"
          : "Threads?$select=ID,Type,Name,State,Function,ObjectName,ElapsedTime,WaitTime",
      );
      expect(rows).toBeInstanceOf(Array);
    });

    it("reads sessions with their user", async () => {
      const rows = await restGet<unknown[]>(
        h,
        "Sessions?$select=ID&$expand=User($select=Name)&$top=10",
      );
      expect(rows).toBeInstanceOf(Array);
    });

    it("reads audit-log entries (v11; may be empty if auditing off)", async (ctx) => {
      if (h.client.version === 12) ctx.skip("v12 serves the log empty");
      const rows = await restGet<unknown[]>(
        h,
        "AuditLogEntries?$orderby=TimeStamp desc&$top=5",
      );
      expect(rows).toBeInstanceOf(Array);
    });

    it("tm1_list_error_logs returns pagination envelope", async () => {
      const r = await h.ok("tm1_list_error_logs", { limit: 10 });
      expect(r.json).toMatchObject({
        total: expect.any(Number),
        items: expect.any(Array),
      });
    });

    it("tm1_list_error_logs groupBy='process' returns audit summary", async () => {
      const r = await h.ok("tm1_list_error_logs", {
        groupBy: "process",
        limit: 20,
      });
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({
        groupBy: "process",
        totalFiles: expect.any(Number),
        groupCount: expect.any(Number),
        items: expect.any(Array),
      });
      const items = r.json.items as Array<{
        process: string;
        count: number;
        perDay: number;
      }>;
      for (let i = 1; i < items.length; i++) {
        expect(items[i - 1].count).toBeGreaterThanOrEqual(items[i].count);
      }
    });

    // ---- SECURITY (read-tier) ----------------------------------------------

    it("reads clients with their groups", async () => {
      const users = await restGet<
        Array<{ Name: string; Groups: Array<{ Name: string }> }>
      >(h, "Users?$select=Name&$expand=Groups($select=Name)&$top=50");
      expect(users.length).toBeGreaterThan(0); // admin always exists
      expect(users[0]).toHaveProperty("Name");
    });

    it("reads groups, and the caller's own", async () => {
      const groups = await restGet<Array<{ Name: string }>>(
        h,
        "Groups?$select=Name&$top=50",
      );
      expect(groups.length).toBeGreaterThan(0); // ADMIN group always exists
      const mine = await restGet<Array<{ Name: string }>>(
        h,
        "ActiveUser/Groups?$select=Name",
      );
      expect(mine.length).toBeGreaterThan(0);
    });

    it("reads one client by key", async () => {
      const [first] = await restGet<Array<{ Name: string }>>(
        h,
        "Users?$select=Name&$top=1",
      );
      const one = await restGet<{ Name: string }>(
        h,
        `${seg("Users", first.Name)}?$select=Name`,
      );
      expect(one.Name).toBe(first.Name);
    });

    // ---- FILES (read-tier) --------------------------------------------------

    it("tm1_files_read op='list' returns a file listing envelope", async () => {
      const r = await h.ok("tm1_files_read", { op: "list", limit: 20 });
      expect(r.json).toMatchObject({
        total: expect.any(Number),
        items: expect.any(Array),
      });
      expect(r.json).toHaveProperty("path");
    });

    it("tm1_files_read op='search' returns a search envelope", async () => {
      const r = await h.ok("tm1_files_read", {
        op: "search",
        contains: ["."],
        limit: 20,
      });
      expect(r.json).toMatchObject({
        total: expect.any(Number),
        items: expect.any(Array),
      });
    });

    // ---- FILE lifecycle (safe, reversible) ---------------------------------

    it("FILE lifecycle: upload -> read back -> delete", async () => {
      const up = await h.ok("tm1_files_write", {
        op: "upload",
        fileName: FILE_NAME,
        content: FILE_BODY,
        confirm: FILE_NAME,
      });
      expect(up.json).toMatchObject({ success: true });

      const get = await h.ok("tm1_files_read", {
        op: "get",
        fileName: FILE_NAME,
      });
      expect(get.json.fileName).toBe(FILE_NAME);
      expect(get.json.content).toBe(FILE_BODY);
      expect(get.json.truncated).toBe(false);

      const del = await h.ok("tm1_files_write", {
        op: "delete",
        fileName: FILE_NAME,
        confirm: FILE_NAME,
      });
      expect(del.json).toMatchObject({ success: true, deleted: true });

      // Confirm gone: subsequent read errors with NOT_FOUND.
      const after = await h.call("tm1_files_read", {
        op: "get",
        fileName: FILE_NAME,
      });
      expect(after.isError).toBe(true);
    });

    // ---- Negative path ------------------------------------------------------

    it("tm1_files_read op='get' on a nonexistent file -> isError + json.code", async () => {
      const r = await h.call("tm1_files_read", {
        op: "get",
        fileName: `${PREFIX}_DOES_NOT_EXIST_${Date.now()}.txt`,
      });
      expect(r.isError).toBe(true);
      expect(r.json).toBeTruthy();
      expect(r.json).toHaveProperty("code");
      expect(typeof r.json.code).toBe("string");
    });
  },
);
