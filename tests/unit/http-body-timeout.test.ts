// A TM1 response whose body stalls after the headers must not hang the call.
// These tests run against a real local HTTP server, so the stall happens on
// the wire rather than in a fake that could hide a missing deadline.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { freeCellset } from "../../src/tm1-client/services/cellset-transform.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockLogger } from "../helpers/client-harness.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Fails the test instead of hanging the suite when the deadline is not applied.
function within<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("still hanging")), ms);
  });
  return Promise.race([p, hang]).finally(() => clearTimeout(timer));
}

// Headers at once, then a body that never finishes.
const stallAfterHeaders =
  (status = 200): Handler =>
  (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.write("[");
  };

describe("deadline covers the response body", () => {
  let server: Server;
  let handler: Handler;
  let hits: number;
  let client: TM1HttpClient;
  let baseUrl: string;

  beforeEach(async () => {
    hits = 0;
    handler = () => undefined;
    server = createServer((req, res) => {
      hits++;
      res.on("error", () => undefined);
      handler(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    // 150 ms of silence is the budget; every stall below is longer.
    const config = makeTestConfig({ baseUrl, requestTimeoutMs: 150 });
    const sm = new SessionManager(config, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("c");
    client = new TM1HttpClient(config, sm, mockLogger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("times a GET out while the JSON body stalls, without retrying it", async () => {
    handler = stallAfterHeaders();
    await expect(
      within(client.request("GET", "/api/v1/Cubes")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(hits).toBe(1);
  });

  it("honours a caller cancel that arrives during the body", async () => {
    handler = stallAfterHeaders();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await expect(
      within(
        client.request("GET", "/api/v1/Cubes", undefined, {
          timeoutMs: 60000,
          signal: ctl.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toBe(1);
  });

  it("times a POST out while the body stalls, sending it once", async () => {
    handler = stallAfterHeaders();
    await expect(
      within(client.request("POST", "/api/v1/ExecuteMDX", { MDX: "x" })),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(hits).toBe(1);
  });

  it("times the raw text and raw byte reads out as well", async () => {
    handler = stallAfterHeaders();
    await expect(
      within(client.requestRaw("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    await expect(
      within(client.requestRawBytes("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  it("answers with the HTTP error when an error body stalls", async () => {
    handler = stallAfterHeaders(500);
    await expect(
      within(client.request("POST", "/api/v1/x", {})),
    ).rejects.toMatchObject({ httpStatus: 500 });
    await expect(
      within(client.requestRaw("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ httpStatus: 500 });
  });

  it("lets a body that keeps streaming run past the budget", async () => {
    // Eight chunks 50 ms apart: 400 ms of body against a 150 ms budget. TM1
    // streams large cellsets, and a total budget would cut them off.
    const streamed: Handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("[0");
      let i = 1;
      const next = () => {
        if (res.destroyed) return;
        if (i < 8) {
          res.write(`,${i++}`);
          setTimeout(next, 50);
        } else {
          res.end("]");
        }
      };
      setTimeout(next, 50);
    };
    handler = streamed;
    await expect(within(client.request("GET", "/api/v1/x"))).resolves.toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    handler = streamed;
    await expect(within(client.requestRaw("GET", "/api/v1/x"))).resolves.toBe(
      "[0,1,2,3,4,5,6,7]",
    );
  });

  it("times out when the stream falls silent for longer than the budget", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("[0");
      setTimeout(() => {
        if (!res.destroyed) res.end(",1]");
      }, 400);
    };
    await expect(
      within(client.request("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  it("times the login out while its body stalls", async () => {
    handler = stallAfterHeaders();
    const sm = new SessionManager(
      makeTestConfig({ baseUrl, requestTimeoutMs: 150 }),
      mockLogger,
    );
    await expect(within(sm.authenticate())).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(hits).toBe(1);
  });
});

describe("freeCellset after a cancelled read", () => {
  let server: Server;
  let handler: Handler;
  let seen: string[];
  let client: TM1HttpClient;

  beforeEach(async () => {
    seen = [];
    handler = () => undefined;
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.on("error", () => undefined);
      handler(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    const config = makeTestConfig({
      baseUrl: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 150,
    });
    const sm = new SessionManager(config, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("c");
    client = new TM1HttpClient(config, sm, mockLogger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("still sends the DELETE when the caller's signal is already aborted", async () => {
    // The caller's request was cancelled before cleanup ran. freeCellset takes
    // no signal of its own, so the DELETE goes out with a live one.
    const caller = new AbortController();
    caller.abort();
    expect(caller.signal.aborted).toBe(true);

    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    await within(freeCellset(client, "abc"));
    expect(seen).toEqual(["DELETE /api/v1/Cellsets('abc')"]);
  });

  it("never throws when the release fails", async () => {
    handler = (_req, res) => {
      res.socket?.destroy();
    };
    await expect(within(freeCellset(client, "abc"))).resolves.toBeUndefined();
    expect(seen).toEqual(["DELETE /api/v1/Cellsets('abc')"]);
  });
});

// Measured against undici: a 1 MB or unfinished body that nobody reads keeps
// its connection; a cancel releases it.
describe("a body the reader leaves alone is released", () => {
  let client: TM1HttpClient;

  // A body that stays open, as a gateway's login page on a 401 can.
  function openBody(status: number, cancelled: () => void) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
      cancel: cancelled,
    });
    return new Response(body, { status });
  }

  beforeEach(() => {
    const config = makeTestConfig({ baseUrl: "http://127.0.0.1:1" });
    const sm = new SessionManager(config, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("c");
    vi.spyOn(sm, "authenticate").mockResolvedValue("c2");
    client = new TM1HttpClient(config, sm, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["request", () => client.request("GET", "/api/v1/x")],
    ["requestRaw", () => client.requestRaw("GET", "/api/v1/x")],
  ])("cancels the 401 body before the re-auth (%s)", async (_name, call) => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(openBody(401, cancelled))
        .mockResolvedValueOnce(new Response('{"a":1}', { status: 200 })),
    );
    await within(call());
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("cancels the answer to an upload, which nobody reads", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(openBody(200, cancelled)));
    await within(client.requestBinary("PUT", "/api/v1/x", new Uint8Array([1])));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
