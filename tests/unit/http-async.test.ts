// RequestOptions.async: Prefer: respond-async, then poll /_async('id').
// Wire shapes are the ones measured on 11.8 (see awaitAsync in http.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type pino from "pino";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

const EXEC = "/api/v1/Processes('p')/tm1.ExecuteWithReturn";

const accepted = (location = "../_async('abc')"): Response =>
  new Response(null, { status: 202, headers: { location } });
const running = (): Response =>
  new Response(null, {
    status: 202,
    headers: { location: "_async('abc')" },
  });
const done = (asyncresult: string, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { asyncresult },
  });

function urlOf(spy: FnSpy, i: number): string {
  return String(spy.mock.calls[i][0]);
}
function initOf(spy: FnSpy, i: number): RequestInit {
  return spy.mock.calls[i][1] as RequestInit;
}

function makeClient(overrides: Partial<TM1Config> = {}): TM1HttpClient {
  const cfg: TM1Config = { ...baseTestConfig, ...overrides };
  const sm = new SessionManager(cfg, mockLogger);
  vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
  return new TM1HttpClient(cfg, sm, mockLogger);
}

describe("TM1HttpClient async operations", () => {
  let fetchSpy: FnSpy;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends Prefer: respond-async and polls until the result arrives", async () => {
    const result = { ProcessExecuteStatusCode: "CompletedSuccessfully" };
    fetchSpy
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(done("201 Created", result));

    const out = await makeClient().request("POST", EXEC, {}, { async: true });

    expect(out).toEqual(result);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const headers = initOf(fetchSpy, 0).headers as Record<string, string>;
    expect(headers.Prefer).toBe("respond-async,wait=55");
    // Only the id is taken from the relative Location; the path is rebuilt.
    expect(urlOf(fetchSpy, 1)).toBe(
      "https://tm1server:8010/api/v1/_async('abc')",
    );
    expect(initOf(fetchSpy, 1).method).toBe("GET");
  });

  it("does not send Prefer without async", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await makeClient().request("POST", EXEC, {});
    const headers = initOf(fetchSpy, 0).headers as Record<string, string>;
    expect(headers.Prefer).toBeUndefined();
  });

  it("takes the status from the asyncresult header, not the poll", async () => {
    fetchSpy.mockResolvedValueOnce(accepted()).mockResolvedValueOnce(
      done("500 Internal Server Error", {
        error: { code: "174", message: "TM1UserException: Cancel" },
      }),
    );

    const err = await makeClient()
      .request("POST", EXEC, {}, { async: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).httpStatus).toBe(500);
    expect((err as TM1Error).message).toBe("TM1UserException: Cancel");
  });

  it("returns undefined for an asyncresult of 204", async () => {
    fetchSpy
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(done("204 No Content"));
    const out = await makeClient().request("POST", EXEC, {}, { async: true });
    expect(out).toBeUndefined();
  });

  it("accepts a synchronous answer from a server that ignores the preference", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"ProcessExecuteStatusCode":"CompletedSuccessfully"}', {
        status: 200,
      }),
    );
    const out = await makeClient().request("POST", EXEC, {}, { async: true });
    expect(out).toEqual({ ProcessExecuteStatusCode: "CompletedSuccessfully" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("DELETEs the operation when the caller aborts", async () => {
    const controller = new AbortController();
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (init.method === "POST") return Promise.resolve(accepted());
      controller.abort(new DOMException("cancelled", "AbortError"));
      return Promise.resolve(running());
    });

    await expect(
      makeClient().request(
        "POST",
        EXEC,
        {},
        { async: true, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const del = fetchSpy.mock.calls.findIndex(
      (c) => (c[1] as RequestInit).method === "DELETE",
    );
    expect(del).toBeGreaterThan(0);
    expect(urlOf(fetchSpy, del)).toBe(
      "https://tm1server:8010/api/v1/_async('abc')",
    );
  });

  it("stops waiting at timeoutMs without cancelling the run", async () => {
    fetchSpy.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(init.method === "POST" ? accepted() : running()),
    );

    const err = await makeClient()
      .request("POST", EXEC, {}, { async: true, timeoutMs: 250 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).code).toBe(TM1ErrorCode.LOCK_TIMEOUT);
    expect((err as TM1Error).message).toContain("NOT cancelled");
    expect(
      fetchSpy.mock.calls.some(
        (c) => (c[1] as RequestInit).method === "DELETE",
      ),
    ).toBe(false);
  });

  it("reports a poll 404 as lost track, never as NOT_FOUND", async () => {
    // ChoreService re-runs a chore on NOT_FOUND; a poll 404 must not trigger it.
    fetchSpy
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"gone"}}', { status: 404 }),
      );

    const err = await makeClient()
      .request("POST", EXEC, {}, { async: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).code).toBe(TM1ErrorCode.CONNECTION_FAILED);
  });

  it("tolerates a transient poll failure", async () => {
    const result = { ProcessExecuteStatusCode: "CompletedSuccessfully" };
    fetchSpy
      .mockResolvedValueOnce(accepted())
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(done("201 Created", result));
    const out = await makeClient().request("POST", EXEC, {}, { async: true });
    expect(out).toEqual(result);
  });

  it("reroots the poll path on v12", async () => {
    fetchSpy
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(done("201 Created", {}));
    const client = makeClient({
      baseUrl: "http://host:4444",
      tm1Version: "12.0",
      version: 12,
      instance: "tm1",
      database: "db1",
      authMode: "s2s",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    await client.request("POST", EXEC, {}, { async: true });
    expect(urlOf(fetchSpy, 1)).toBe(
      "http://host:4444/tm1/api/v1/Databases('db1')/_async('abc')",
    );
  });
});
