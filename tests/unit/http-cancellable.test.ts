// RequestOptions.cancellable: a read TM1 has received runs to its end whatever
// the client does, so the cancellable path runs it as an asynchronous operation
// and DELETEs it when the budget runs out or the caller aborts. The wire shapes
// are the ones measured on 11.8 and v12 (2026-11-17): 202 + Location on the
// POST, 202 while working, then HTTP 200 with the real status in `asyncresult`,
// DELETE to cancel or free.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { baseTestConfig } from "../helpers/tm1-config.js";
import { mockLogger } from "../helpers/client-harness.js";
import { tm1Events } from "../../src/lib/tm1-events.js";
import { withToolHint } from "../../src/tools/error-format.js";

const MDX = "/api/v1/ExecuteMDX";
const HANDLE = "_async('h1')";
const accepted = (location: string = HANDLE) =>
  new Response(null, { status: 202, headers: { location } });
const pending = () => new Response(null, { status: 202 });
const result = (asyncresult: string, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { asyncresult },
  });
const freed = (status = 204) => new Response(null, { status });

type Call = {
  method: string;
  url: string;
  prefer: string | undefined;
  init: RequestInit;
};

function setup(
  version: 11 | 12,
  answer: (call: Call, n: number) => Response | Promise<Response>,
  requestTimeoutMs = 60000,
) {
  const cfg: TM1Config = {
    ...baseTestConfig,
    baseUrl: "https://tm1server:8010",
    version,
    tm1Version: version === 12 ? "12.0" : "11.8",
    requestTimeoutMs,
    ...(version === 12
      ? {
          baseUrl: "http://host:4444",
          instance: "tm1",
          database: "db1",
          authMode: "s2s" as const,
          clientId: "client-id",
          clientSecret: "client-secret",
        }
      : {}),
  };
  const sm = new SessionManager(cfg, mockLogger);
  vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
  const calls: Call[] = [];
  const fetchSpy: FnSpy = vi.fn(
    async (url: string, init: RequestInit): Promise<Response> => {
      const call: Call = {
        method: init.method ?? "GET",
        url: String(url).replace(/^https?:\/\/[^/]+/, ""),
        prefer: (init.headers as Record<string, string>).Prefer,
        init,
      };
      calls.push(call);
      return answer(call, calls.length);
    },
  );
  stubContractCheckedFetch(fetchSpy);
  return { client: new TM1HttpClient(cfg, sm, mockLogger), calls };
}

const run = (client: TM1HttpClient, opts: { signal?: AbortSignal } = {}) =>
  client.request(
    "POST",
    MDX,
    { MDX: "SELECT" },
    { cancellable: true, ...opts },
  );
const flush = () => new Promise((r) => setTimeout(r, 0));

// A poll that never answers ends by its own deadline, not between two polls.
const hangUntilAbort = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(init.signal?.reason as Error),
    );
  });

describe("TM1HttpClient, cancellable request", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("polls the handle, returns the body and frees the result", async () => {
    const { client, calls } = setup(11, (c, n) =>
      c.method === "POST"
        ? accepted()
        : c.method === "DELETE"
          ? freed()
          : n < 4
            ? pending()
            : result("201 Created", { ID: "c1" }),
    );
    await expect(run(client)).resolves.toEqual({ ID: "c1" });
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", prefer: "respond-async" });
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(1)).toEqual([
      `GET /api/v1/${HANDLE}`,
      `GET /api/v1/${HANDLE}`,
      `GET /api/v1/${HANDLE}`,
      `DELETE /api/v1/${HANDLE}`,
    ]);
  });

  it("finds the handle behind a Location relative to a nested request path", async () => {
    // A view's tm1.Execute answers `../../_async('<id>')`. The regex takes the
    // id wherever it sits, and the path is rebuilt under the API root.
    const { client, calls } = setup(11, (c) =>
      c.method === "POST"
        ? accepted(`../../${HANDLE}`)
        : c.method === "DELETE"
          ? freed()
          : result("201 Created", { ID: "c1" }),
    );
    await client.request(
      "POST",
      "/api/v1/Cubes('C')/Views('V')/tm1.Execute",
      undefined,
      { cancellable: true },
    );
    expect(calls[1]?.url).toBe(`/api/v1/${HANDLE}`);
  });

  it("does not announce a model mutation when it frees the handle", async () => {
    const seen: string[] = [];
    const on = (e: { path: string }): void => void seen.push(e.path);
    tm1Events.on("mutation", on);
    try {
      const { client } = setup(11, (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? freed()
            : result("201 Created", { ID: "c1" }),
      );
      await run(client);
      await flush();
      expect(seen).toEqual([MDX]);
    } finally {
      tm1Events.off("mutation", on);
    }
  });

  it("reports a handle TM1 no longer knows as lost track, never as NOT_FOUND", async () => {
    // Same rule as the plain async path: a poll 404 says nothing about the
    // resource, so ChoreService-style re-runs on NOT_FOUND cannot trigger.
    const { client } = setup(11, (c) =>
      c.method === "POST" ? accepted() : new Response(null, { status: 404 }),
    );
    await expect(run(client)).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
      endpoint: MDX,
      message: expect.stringMatching(/Lost track/),
    });
  });

  it("keeps the cancel outcome through a tool's own hint", async () => {
    const { client } = setup(
      12,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? freed()
            : pending(),
      120,
    );
    await expect(
      withToolHint(run(client), "MDX execution failed. Common causes: …"),
    ).rejects.toMatchObject({
      cancelled: true,
      hint: expect.stringMatching(/accepted the cancel/),
    });
  });

  it("judges the result by asyncresult, not by the HTTP 200 it arrives with", async () => {
    const { client, calls } = setup(11, (c) =>
      c.method === "POST"
        ? accepted()
        : c.method === "DELETE"
          ? freed()
          : result("404 Not Found", { error: { message: "no such cube" } }),
    );
    await expect(run(client)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
      message: "no such cube",
    });
    await flush();
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("reads the bare number v12 sends in asyncresult", async () => {
    const { client } = setup(12, (c) =>
      c.method === "POST"
        ? accepted()
        : c.method === "DELETE"
          ? freed()
          : result("400", { error: { message: "bad mdx" } }),
    );
    await expect(run(client)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("takes a direct answer from a server that ignores the preference", async () => {
    const { client, calls } = setup(
      11,
      () => new Response(JSON.stringify({ ID: "c1" }), { status: 201 }),
    );
    await expect(run(client)).resolves.toEqual({ ID: "c1" });
    expect(calls).toHaveLength(1);
  });

  it("cancels on timeout and says the query was stopped on v11", async () => {
    const { client, calls } = setup(
      11,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? freed()
            : pending(),
      120,
    );
    await expect(run(client)).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
      cancelled: true,
      hint: expect.stringMatching(/was cancelled on the server/),
    });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("does not claim a stop on v12, where a cancel may run to the end", async () => {
    const { client } = setup(
      12,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? freed()
            : pending(),
      120,
    );
    await expect(run(client)).rejects.toMatchObject({
      cancelled: true,
      hint: expect.stringMatching(/accepted the cancel.*tm1_list_jobs/),
    });
  });

  it("reports an unconfirmed cancel as such", async () => {
    const { client } = setup(
      11,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? new Response("{}", { status: 500 })
            : pending(),
      120,
    );
    await expect(run(client)).rejects.toMatchObject({
      cancelled: false,
      hint: expect.stringMatching(/may still be running.*tm1_list_threads/),
    });
  });

  it.each([
    [204, true, /accepted the cancel.*tm1_list_jobs/],
    [500, false, /may still be running.*tm1_list_jobs/],
  ])(
    "reports the cancel outcome when the poll itself hangs (DELETE %i)",
    async (deleteStatus, cancelled, hint) => {
      const { client, calls } = setup(
        12,
        (c) =>
          c.method === "POST"
            ? accepted()
            : c.method === "DELETE"
              ? freed(deleteStatus)
              : hangUntilAbort(c.init),
        120,
      );
      await expect(
        withToolHint(run(client), "MDX execution failed. Common causes: …"),
      ).rejects.toMatchObject({
        code: "LOCK_TIMEOUT",
        cancelled,
        hint: expect.stringMatching(hint),
      });
      expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    },
  );

  it("gives a hanging poll the rest of the budget, not a new one", async () => {
    vi.useFakeTimers();
    const { client, calls } = setup(
      11,
      (c) =>
        c.method === "POST"
          ? new Promise<Response>((r) => setTimeout(() => r(accepted()), 8000))
          : c.method === "DELETE"
            ? freed()
            : hangUntilAbort(c.init),
      10000,
    );
    const outcome = expect(run(client)).rejects.toMatchObject({
      cancelled: true,
    });
    // 8 s to the handle, then the 5 s floor instead of another 10 s.
    await vi.advanceTimersByTimeAsync(13100);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    await outcome;
  });

  it("cancels on the server when the caller aborts, and rethrows the abort", async () => {
    const ac = new AbortController();
    const { client, calls } = setup(11, (c, n) => {
      if (c.method === "POST") return accepted();
      if (c.method === "DELETE") return freed();
      if (n === 3) {
        ac.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return pending();
    });
    await expect(run(client, { signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: `/api/v1/${HANDLE}`,
    });
  });

  it("leaves a plain request untouched", async () => {
    const { client, calls } = setup(
      11,
      () => new Response(JSON.stringify({ ID: "c1" }), { status: 200 }),
    );
    await client.request("POST", MDX, { MDX: "SELECT" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: MDX });
    expect(calls[0]?.prefer).toBeUndefined();
  });
});
