// Live integration: OPERATIONS / SECURITY / FILES domains.
//
// Drives the real MCP tool layer (zod schema -> withAnnotations -> handler ->
// TM1Client -> OData) against a running TM1 server, exactly as an MCP client
// would. Security reads go through tm1_rest_read, the paths the prompts and
// hints name; the monitoring reads (threads, sessions, log collections) live in
// rest.live.test.ts.
//
// Safe lifecycle exercised end-to-end under the SANDBOX prefix:
//   - FILE: upload -> read back -> delete.
// Nothing touches clients or groups: security writes on a shared server are
// out of scope for the live suite.
//
// Deliberately AVOIDED: tm1_save_data (global flush).
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

describe.skipIf(!LIVE_ENABLED)("live: ops / security / files", () => {
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

  // ---- OPERATIONS (read-tier) ---------------------------------------------

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

  it("legacy response mode ships the body twice: text AND structuredContent", async () => {
    const r = await h.ok("tm1_get_server_state");
    expect(r.text).toBeTruthy();
    expect(r.result.structuredContent).toBeTruthy();
    expect(JSON.parse(r.text as string)).toEqual(r.result.structuredContent);
  });

  it("tm1_get_error_log_content fetches a real log or errors cleanly on a bogus name", async () => {
    const list = await h.ok("tm1_list_error_logs", { limit: 1 });
    const items = (list.json?.items ?? list.json) as unknown;
    const first = Array.isArray(items) ? items[0] : undefined;
    const filename =
      typeof first === "string" ? first : (first as { name?: string })?.name;
    if (filename) {
      const r = await h.ok("tm1_get_error_log_content", {
        filename,
        tail: 20,
      });
      expect(r.isError).toBe(false);
      expect(r.json ?? r.text).toBeTruthy();
    } else {
      // No error logs on this server — exercise the not-found path instead.
      const r = await h.call("tm1_get_error_log_content", {
        filename: `${SANDBOX}_DOES_NOT_EXIST.log`,
      });
      expect(r.isError).toBe(true);
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

  it("reads groups", async () => {
    const groups = await restGet<Array<{ Name: string }>>(
      h,
      "Groups?$select=Name&$top=50",
    );
    expect(groups.length).toBeGreaterThan(0); // ADMIN group always exists
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
});
