import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { tm1Events, type Tm1MutationEvent } from "../../src/lib/tm1-events.js";
import { mockLogger } from "../helpers/client-harness.js";

describe("R2-05: HTTP layer emits mutation events", () => {
  let client: TM1HttpClient;
  let events: Tm1MutationEvent[];
  let listener: (e: Tm1MutationEvent) => void;

  beforeEach(() => {
    const cfg = makeTestConfig({ requestTimeoutMs: 60000 });
    const sm = new SessionManager(cfg, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
    client = new TM1HttpClient(cfg, sm, mockLogger);

    events = [];
    listener = (e) => events.push(e);
    tm1Events.on("mutation", listener);
  });

  afterEach(() => {
    tm1Events.off("mutation", listener);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits on successful POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    await client.request("POST", "/api/v1/Dimensions", { Name: "Test" });
    expect(events).toEqual([
      {
        method: "POST",
        path: "/api/v1/Dimensions",
        connectionId: "tm1server_8010",
      },
    ]);
  });

  it("emits on successful DELETE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    await client.request("DELETE", "/api/v1/Cubes('Old')");
    expect(events).toEqual([
      {
        method: "DELETE",
        path: "/api/v1/Cubes('Old')",
        connectionId: "tm1server_8010",
      },
    ]);
  });

  it("does not emit on GET (safe method)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue("{}"),
      }),
    );

    await client.request("GET", "/api/v1/Configuration");
    expect(events).toEqual([]);
  });

  it("does not emit when request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue("boom"),
      }),
    );

    await expect(client.request("POST", "/api/v1/Bad")).rejects.toThrow();
    expect(events).toEqual([]);
  });
});
