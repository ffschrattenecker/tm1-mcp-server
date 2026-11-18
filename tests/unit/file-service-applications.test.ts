// The Applications tree is addressed unlike Blobs, and every difference here
// was measured against 11.8 (2026-09-21): entries are keyed by ID rather than
// by Name, a document's bytes sit behind a derived-type cast, and creating one
// is a POST without Content followed by a PUT. These tests pin the request
// shapes so a refactor cannot quietly go back to name-keyed URLs.
import { describe, it, expect, vi } from "vitest";
import { FileService } from "../../src/tm1-client/services/file-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";

const ROOT = "/api/v1/Contents('Applications')";
const CAST = "ibm.tm1.api.v1.DocumentReference";

const entry = (kind: string, id: string, name: string) => ({
  ID: id,
  Name: name,
  "@odata.type": `#ibm.tm1.api.v1.${kind}`,
});

/** Tree: folder "Reports" holding a document and a view reference. */
function makeService() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const listings: Record<string, unknown[]> = {
    [`${ROOT}/Contents`]: [
      entry("Folder", "Reports", "Reports"),
      entry("Folder", "Empty", "Empty"),
    ],
    [`${ROOT}/Contents('Empty')/Contents`]: [],
    [`${ROOT}/Contents('Reports')/Contents`]: [
      entry("DocumentReference", "sheet.xlsx.blob", "sheet.xlsx"),
      entry("ViewReference", "by_month.view", "by_month"),
    ],
  };
  const http = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      // v12 drops `ID` from a listing unless it is selected, so every listing
      // GET must carry the $select; the fake answers only when it does.
      const SEL = "?$select=ID,Name";
      const hit =
        method === "GET"
          ? path.endsWith(SEL)
            ? listings[path.slice(0, -SEL.length)]
            : undefined
          : listings[path];
      if (hit && method === "GET") return { value: hit };
      if (method === "POST") {
        // Mirror the server: a posted Document surfaces as a DocumentReference
        // whose ID is the name with ".blob" appended.
        const name = (body as { Name: string }).Name;
        listings[path] = [
          ...(hit ?? []),
          entry("DocumentReference", `${name}.blob`, name),
        ];
        return undefined;
      }
      if (method === "DELETE") return undefined;
      throw Object.assign(new Error(`no stub for ${path}`), {
        code: "NOT_FOUND",
      });
    }),
    requestRawBytes: vi.fn(async (method: string, path: string) => {
      calls.push({ method, path });
      return Buffer.from("payload");
    }),
    requestBinary: vi.fn(
      async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
      },
    ),
  } as unknown as TM1HttpClient;
  return { svc: new FileService(http), calls };
}

describe("FileService, applications container", () => {
  it("reads a document through the ID key and the derived-type cast", async () => {
    const { svc, calls } = makeService();
    const bytes = await svc.getContentBytes(
      "Reports/sheet.xlsx",
      "applications",
    );

    expect(bytes.toString()).toBe("payload");
    expect(calls.at(-1)?.path).toBe(
      `${ROOT}/Contents('Reports')/Contents('sheet.xlsx.blob')/${CAST}/Document/Content`,
    );
  });

  it("refuses a view reference by name instead of fetching nothing", async () => {
    const { svc } = makeService();
    await expect(
      svc.getContentBytes("Reports/by_month", "applications"),
    ).rejects.toThrow(/ViewReference, which carries no file content/);
  });

  it("names the segment that does not exist", async () => {
    const { svc } = makeService();
    await expect(
      svc.getContentBytes("Reports/absent.csv", "applications"),
    ).rejects.toThrow(/'absent.csv' not found in the Applications tree/);
  });

  it("creates a document without inlining Content, then PUTs the bytes", async () => {
    const { svc, calls } = makeService();
    const res = await svc.upload(
      "Reports/fresh.csv",
      Buffer.from("a,b"),
      "applications",
    );
    expect(res).toEqual({ created: true, root: "Applications" });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${ROOT}/Contents('Reports')/Contents`);
    expect(post?.body).toEqual({
      "@odata.type": "#ibm.tm1.api.v1.Document",
      Name: "fresh.csv",
    });
    expect(post?.body).not.toHaveProperty("Content");
    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      path: `${ROOT}/Contents('Reports')/Contents('fresh.csv.blob')/${CAST}/Document/Content`,
    });
  });

  it("deletes by resolved ID, not by name", async () => {
    const { svc, calls } = makeService();
    await svc.delete("Reports/sheet.xlsx", "applications");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: `${ROOT}/Contents('Reports')/Contents('sheet.xlsx.blob')`,
    });
  });
  it("refuses a folder that holds entries before the DELETE goes out", async () => {
    // DELETE on a folder removes its contents too, so a filled one must never
    // reach the server.
    const { svc, calls } = makeService();
    await expect(svc.delete("Reports", "applications")).rejects.toThrow(
      /is a folder holding 2 entries/,
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes an empty folder", async () => {
    const { svc, calls } = makeService();
    await svc.delete("Empty", "applications");
    expect(calls.at(-1)).toEqual({
      method: "DELETE",
      path: `${ROOT}/Contents('Empty')`,
      body: undefined,
    });
  });

  it("keeps the folder advice through a tool's hint, which fills in where none is set", async () => {
    const { withToolHint } = await import("../../src/tools/error-format.js");
    const { svc } = makeService();
    await expect(
      withToolHint(svc.delete("Reports", "applications"), "tool hint"),
    ).rejects.toMatchObject({
      hint: "Delete the entries first; an empty folder is deleted.",
    });
    await expect(
      withToolHint(svc.delete("Absent", "applications"), "tool hint"),
    ).rejects.toMatchObject({ hint: "tool hint" });
  });

  it("refuses a view reference in the delete path as well", async () => {
    const { svc, calls } = makeService();
    await expect(
      svc.delete("Reports/by_month", "applications"),
    ).rejects.toThrow(/is a ViewReference, not a file/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("removes an entry it created when the content PUT fails", async () => {
    // Create and write are two requests; a half-written upload must not leave
    // the name occupied by an empty document.
    const { svc, calls } = makeService();
    const http = (svc as unknown as { http: TM1HttpClient }).http;
    vi.mocked(http.requestBinary).mockRejectedValueOnce(new Error("no space"));

    await expect(
      svc.upload("Reports/new.csv", Buffer.from("x"), "applications"),
    ).rejects.toThrow(/no space/);
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: `${ROOT}/Contents('Reports')/Contents('new.csv.blob')`,
    });
  });
  describe("folders in the 'files' container", () => {
    const FILES = "/api/v1/Contents('Files')";
    const item = (kind: string, name: string) => ({
      Name: name,
      "@odata.type": `#ibm.tm1.api.v1.${kind}`,
    });
    function filesService(version: 11 | 12) {
      const calls: string[] = [];
      const answers: Record<string, unknown> = {
        [`GET ${FILES}/Contents('imports')?$select=Name`]: item(
          "Folder",
          "imports",
        ),
        [`GET ${FILES}/Contents('imports')/Contents?$select=ID,Name`]: {
          value: [item("Document", "x.csv")],
        },
        [`GET ${FILES}/Contents('empty')?$select=Name`]: item(
          "Folder",
          "empty",
        ),
        [`GET ${FILES}/Contents('empty')/Contents?$select=ID,Name`]: {
          value: [],
        },
        [`GET ${FILES}/Contents('a.csv')?$select=Name`]: item(
          "Document",
          "a.csv",
        ),
      };
      const http = {
        version,
        request: vi.fn(async (method: string, path: string) => {
          calls.push(`${method} ${path}`);
          if (method !== "GET") return undefined;
          const hit = answers[`${method} ${path}`];
          if (hit !== undefined) return hit;
          throw Object.assign(new Error(`no stub for ${path}`), {
            code: "NOT_FOUND",
          });
        }),
      } as unknown as TM1HttpClient;
      return { svc: new FileService(http), calls };
    }

    it("refuses to delete a v12 folder that holds entries, before the DELETE", async () => {
      const { svc, calls } = filesService(12);
      await expect(svc.delete("imports")).rejects.toThrow(
        /is a folder holding 1 entry/,
      );
      expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    });

    it("deletes an empty v12 folder", async () => {
      const { svc, calls } = filesService(12);
      await svc.delete("empty");
      expect(calls.at(-1)).toBe(`DELETE ${FILES}/Contents('empty')`);
    });

    it("deletes a v12 file without listing it as a folder", async () => {
      const { svc, calls } = filesService(12);
      await svc.delete("a.csv");
      expect(calls).toEqual([
        `GET ${FILES}/Contents('a.csv')?$select=Name`,
        `DELETE ${FILES}/Contents('a.csv')`,
      ]);
    });

    it("falls back to Blobs when Files does not know the name", async () => {
      const { svc, calls } = filesService(11);
      await svc.delete("old.csv");
      expect(calls).toEqual([
        `GET ${FILES}/Contents('old.csv')?$select=Name`,
        "DELETE /api/v1/Contents('Blobs')/Contents('old.csv')",
      ]);
    });
  });

  it("follows @odata.nextLink when a listing is paged", async () => {
    const calls: string[] = [];
    const page2 = `${ROOT}/Contents?$skiptoken=2`;
    const http = {
      request: vi.fn(async (_method: string, path: string) => {
        calls.push(path);
        if (path === `${ROOT}/Contents?$select=ID,Name`) {
          return {
            value: [entry("DocumentReference", "a.csv.blob", "a.csv")],
            "@odata.nextLink": `https://tm1.invalid${page2}`,
          };
        }
        if (path === page2) {
          return {
            value: [entry("DocumentReference", "b.csv.blob", "b.csv")],
          };
        }
        throw new Error(`no stub for ${path}`);
      }),
    } as unknown as TM1HttpClient;

    const names = await new FileService(http).list(undefined, "applications");
    expect(names).toEqual(["a.csv", "b.csv"]);
    expect(calls).toEqual([`${ROOT}/Contents?$select=ID,Name`, page2]);
  });
});
