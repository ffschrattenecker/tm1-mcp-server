import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { tm1Events, type Tm1MutationEvent } from "../../src/lib/tm1-events.js";
import { mockLogger } from "../helpers/client-harness.js";

describe("HTTP layer emits mutation events", () => {
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

  it.each<[string, string, number, boolean]>([
    ["POST", "/api/v1/Dimensions", 204, true],
    ["DELETE", "/api/v1/Cubes('Old')", 204, true],
    ["GET", "/api/v1/Configuration", 200, false],
    ["POST", "/api/v1/Bad", 500, false],
  ])(
    "%s %s (HTTP %i) emits a mutation event: %s",
    async (method, path, status, emits) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: status < 300,
          status,
          statusText: "",
          headers: new Headers(),
          text: vi.fn().mockResolvedValue("{}"),
        }),
      );

      await client
        .request(method, path, method === "POST" ? { Name: "Test" } : undefined)
        .catch(() => undefined);
      expect(events).toEqual(
        emits ? [{ method, path, connectionId: "tm1server_8010" }] : [],
      );
    },
  );
});
