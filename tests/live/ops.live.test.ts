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
//   - FOLDER and APPLICATIONS document: create, host-path round trip, delete.
// Nothing touches clients or groups: security writes on a shared server are
// out of scope for the live suite.
//
// Deliberately AVOIDED: tm1_save_data (global flush).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getHarness,
  LIVE_ENABLED,
  rawRequest,
  restGet,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const PREFIX = `${SANDBOX}_OPS`;
const FILE_NAME = `${PREFIX}_FILE.txt`;
const FILE_BODY = `${PREFIX} synthetic live-test blob\nline2\nline3\n`;
// 11.8 refuses a document directly under the Applications root, so the
// document goes into a folder of its own.
const DOC_DIR = `${PREFIX}_DIR`;
const DOC_NAME = `${DOC_DIR}/${PREFIX}_DOC.xlsm`;
const APPS = "/api/v1/Contents('Applications')/Contents";

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
    // Removes the test folder whatever is left in it, which no tool does, so
    // it reaches past the service layer for that one request.
    await rawRequest(h, "DELETE", `${APPS}('${DOC_DIR}')`).catch(
      () => undefined,
    );
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

  it("FILES folder: v12 nests and keeps a filled folder, v11 names the flat container", async () => {
    const dir = `${PREFIX}_FDIR`;
    const sub = `${dir}/sub`;
    const mk = (p: string) => ({
      op: "create_folder",
      fileName: p,
      confirm: p,
    });
    const rm = (p: string) => ({ op: "delete", fileName: p, confirm: p });
    const made = await h.call("tm1_files_write", mk(dir));
    if (h.client.version === 11) {
      expect(made.isError).toBe(true);
      expect(made.json.code).toBe("UNSUPPORTED_OPERATION");
      return;
    }
    try {
      expect(made.json).toMatchObject({ created: true, container: "files" });
      const again = await h.ok("tm1_files_write", mk(dir));
      expect(again.json).toMatchObject({ created: false });
      await h.ok("tm1_files_write", mk(sub));

      // DELETE on a v12 folder takes its content along, so this refusal is
      // the only thing between a folder name and everything below it.
      const filled = await h.call("tm1_files_write", rm(dir));
      expect(filled.isError).toBe(true);
      expect(filled.json.code).toBe("UNSUPPORTED_OPERATION");
      const kept = await h.ok("tm1_files_read", { op: "list", path: dir });
      expect(kept.json.items).toEqual(["sub"]);
    } finally {
      await h.call("tm1_files_write", rm(sub));
      await h.call("tm1_files_write", rm(dir));
    }
    const root = await h.ok("tm1_files_read", { op: "list", limit: 500 });
    expect(root.json.items).not.toContain(dir);
  });

  it("APPLICATIONS document: sourcePath up -> writeToFile down, byte-identical", async () => {
    // Bytes that are not valid UTF-8, so a text decode anywhere on the way
    // would change the hash.
    const bytes = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256),
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tm1-live-doc-"));
    const prevRoot = process.env.TM1_LOCAL_FILE_ROOT;
    process.env.TM1_LOCAL_FILE_ROOT = dir;
    const apps = { container: "applications" };
    try {
      const src = path.join(dir, "up.xlsm");
      const dst = path.join(dir, "down.xlsm");
      writeFileSync(src, bytes);
      const folder = {
        op: "create_folder",
        fileName: DOC_DIR,
        confirm: DOC_DIR,
        ...apps,
      };
      const dir1 = await h.ok("tm1_files_write", folder);
      expect(dir1.json).toMatchObject({ success: true, created: true });
      const dir2 = await h.ok("tm1_files_write", folder);
      expect(dir2.json).toMatchObject({ created: false });
      const upload = {
        op: "upload",
        fileName: DOC_NAME,
        sourcePath: src,
        confirm: DOC_NAME,
        ...apps,
      };

      const up = await h.ok("tm1_files_write", upload);
      expect(up.json).toMatchObject({
        success: true,
        created: true,
        bytesUploaded: bytes.byteLength,
        sha256,
        verified: true,
      });

      const get = await h.ok("tm1_files_read", {
        op: "get",
        fileName: DOC_NAME,
        writeToFile: dst,
        ...apps,
      });
      expect(get.json).toEqual({
        fileName: DOC_NAME,
        totalBytes: bytes.byteLength,
        writtenTo: dst,
        sha256,
      });
      expect(readFileSync(dst).equals(bytes)).toBe(true);

      // An existing document is refused by default and replaced on request.
      const again = await h.call("tm1_files_write", upload);
      expect(again.isError).toBe(true);
      expect(again.json.code).toBe("CONFLICT");
      const replaced = await h.ok("tm1_files_write", {
        ...upload,
        overwrite: true,
      });
      expect(replaced.json).toMatchObject({ updated: true, verified: true });

      // A folder goes only once it is empty.
      const rmdir = {
        op: "delete",
        fileName: DOC_DIR,
        confirm: DOC_DIR,
        ...apps,
      };
      const filled = await h.call("tm1_files_write", rmdir);
      expect(filled.isError).toBe(true);
      expect(filled.json.code).toBe("UNSUPPORTED_OPERATION");
      await h.ok("tm1_files_write", {
        op: "delete",
        fileName: DOC_NAME,
        confirm: DOC_NAME,
        ...apps,
      });
      await h.ok("tm1_files_write", rmdir);
      const root = await h.ok("tm1_files_read", {
        op: "list",
        limit: 500,
        ...apps,
      });
      expect(root.json.items).not.toContain(DOC_DIR);
    } finally {
      if (prevRoot === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
      else process.env.TM1_LOCAL_FILE_ROOT = prevRoot;
      rmSync(dir, { recursive: true, force: true });
    }
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
