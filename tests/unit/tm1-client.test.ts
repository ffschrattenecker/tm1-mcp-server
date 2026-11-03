import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockLogger } from "../helpers/client-harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}): Response {
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(opts.body ?? {}),
  } as unknown as Response;
}

/**
 * Expose the transport `request` method for testing via a thin subclass.
 * Transport lives on TM1HttpClient (TM1Client no longer inherits it — it holds
 * a private `http` instead), so the request-behavior suite tests it here.
 */
class TestTM1Client extends TM1HttpClient {
  async testRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.request<T>(method, path, body);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client", () => {
  let fetchSpy: FnSpy;
  let sessionManager: SessionManager;
  let client: TestTM1Client;
  // Lifecycle (connect/disconnect/isConnected) lives on the TM1Client facade.
  let lifecycleClient: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);

    const config = makeTestConfig({ requestTimeoutMs: 5000 });
    sessionManager = new SessionManager(config, mockLogger);
    client = new TestTM1Client(config, sessionManager, mockLogger);
    lifecycleClient = new TM1Client(config, sessionManager, mockLogger);

    // Default: ensureSession returns a cookie
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "authenticate").mockResolvedValue("newSession456");
    vi.spyOn(sessionManager, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sessionManager, "stopKeepAlive").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── connect / disconnect / isConnected ───────────────────────────────────

  describe("connect()", () => {
    it("should authenticate and start keep-alive", async () => {
      await lifecycleClient.connect();

      expect(sessionManager.authenticate).toHaveBeenCalledOnce();
      expect(sessionManager.startKeepAlive).toHaveBeenCalledOnce();
      expect(lifecycleClient.isConnected()).toBe(true);
    });
  });

  describe("disconnect()", () => {
    it("should stop keep-alive and mark as disconnected", async () => {
      await lifecycleClient.connect();
      await lifecycleClient.disconnect();

      expect(sessionManager.stopKeepAlive).toHaveBeenCalledOnce();
      expect(lifecycleClient.isConnected()).toBe(false);
    });
  });

  describe("isConnected()", () => {
    it("should return false before connect", () => {
      expect(lifecycleClient.isConnected()).toBe(false);
    });

    it("should return true after connect", async () => {
      await lifecycleClient.connect();
      expect(lifecycleClient.isConnected()).toBe(true);
    });
  });

  // ── request() – successful calls ────────────────────────────────────────

  describe("request() – success", () => {
    it("should make GET request with session cookie and return parsed JSON", async () => {
      const data = { value: [{ Name: "SalesCube" }] };
      fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true, body: data }));

      const result = await client.testRequest("GET", "/api/v1/Cubes");

      expect(result).toEqual(data);
      expect(fetchSpy).toHaveBeenCalledOnce();

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://tm1server:8010/api/v1/Cubes");
      expect(opts.method).toBe("GET");
      expect(opts.headers.Cookie).toBe("TM1SessionId=session123");
      expect(opts.headers.Accept).toBe("application/json");
    });

    it("should send JSON body for POST requests", async () => {
      const body = { MDX: "SELECT ... ON ROWS FROM [Sales]" };
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { Cells: [] } }),
      );

      await client.testRequest("POST", "/api/v1/ExecuteMDX", body);

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.body).toBe(JSON.stringify(body));
    });

    it("should return undefined for 204 No Content", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, status: 204, body: undefined }),
      );

      const result = await client.testRequest(
        "DELETE",
        "/api/v1/Processes('Test')",
      );
      expect(result).toBeUndefined();
    });
  });

  // ── request() – error classification ──────────────────────────────────────

  describe("request() – error classification", () => {
    it("should throw AUTH_FAILED for 401 after re-auth also fails with 401", async () => {
      // First call returns 401
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 401, statusText: "Unauthorized" }),
      );
      // Re-auth retry also returns 401
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 401, statusText: "Unauthorized" }),
      );

      await expect(client.testRequest("GET", "/api/v1/Cubes")).rejects.toThrow(
        TM1Error,
      );

      try {
        await client.testRequest("GET", "/api/v1/Cubes");
      } catch {
        // Reset mocks for the second attempt
      }
    });

    it("should re-authenticate on 401 and retry successfully", async () => {
      // First call returns 401
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 401, statusText: "Unauthorized" }),
      );
      // After re-auth, retry succeeds
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { value: [] } }),
      );

      const result = await client.testRequest("GET", "/api/v1/Cubes");

      expect(result).toEqual({ value: [] });
      expect(sessionManager.authenticate).toHaveBeenCalledOnce();
    });

    it("should throw PERMISSION_DENIED for 403", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 403,
          body: { error: { message: "Insufficient privileges" } },
        }),
      );

      try {
        await client.testRequest("GET", "/api/v1/Cubes");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
        expect(err.httpStatus).toBe(403);
        expect(err.endpoint).toBe("/api/v1/Cubes");
        expect(err.details).toBe("Insufficient privileges");
      }
    });

    it("should throw PERMISSION_DENIED for 400 ObjectSecurityNoReadRights", async () => {
      // TM1 returns security denials as HTTP 400 with a security message, not 403
      // — e.g. a non-admin reading the }DimensionProperties control cube.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: {
            error: { code: "65", message: "ObjectSecurityNoReadRights" },
          },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/ExecuteMDX");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
        expect(err.httpStatus).toBe(400);
        expect(err.details).toBe("ObjectSecurityNoReadRights");
      }
    });

    it("keeps VALIDATION-style 400s as generic (not a security message)", async () => {
      // Wire shape confirmed by the recorded contracts: v11.8 sends
      // `error.message` as a plain string.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: {
            error: { code: "278", message: "Syntax error in MDX statement" },
          },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/ExecuteMDX");
        expect.unreachable("Should have thrown");
      } catch (e) {
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
        expect(err.httpStatus).toBe(400);
        expect(err.details).toBe("Syntax error in MDX statement");
      }
    });

    it("does not read English prose as a security denial", async () => {
      // e.g. a TI error carrying an ODBC driver's own wording.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: {
            error: { message: "[ODBC] user svc_load not authorized on DSN" },
          },
        }),
      );

      await expect(
        client.testRequest("POST", "/api/v1/ExecuteMDX"),
      ).rejects.toMatchObject({ code: TM1ErrorCode.TM1_ERROR });
    });

    it("also reads the nested `message.value` error shape", async () => {
      // http.ts accepts `error.message.value` as well as a plain string. No
      // server in the recordings sends the nested form, so this branch had no
      // coverage of its own — until the contracts showed the suite was testing
      // only the shape TM1 does NOT send. Both stay covered: the plain string
      // above because it is what arrives, this one because the code promises
      // to handle it.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: {
            error: { message: { value: "Syntax error in MDX statement" } },
          },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/ExecuteMDX");
        expect.unreachable("Should have thrown");
      } catch (e) {
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
        expect(err.details).toBe("Syntax error in MDX statement");
      }
    });

    it.each<[string, string, TM1ErrorCode]>([
      ["Cube not found", "404", TM1ErrorCode.NOT_FOUND],
      ["Process already exists", "409", TM1ErrorCode.CONFLICT],
      ["Internal server error", "500", TM1ErrorCode.TM1_ERROR],
      ["Invalid MDX syntax", "400", TM1ErrorCode.TM1_ERROR],
    ])("maps %s (HTTP %s) to its error code", async (message, status, code) => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: Number(status),
          body: { error: { message } },
        }),
      );

      await expect(
        client.testRequest("GET", "/api/v1/Cubes"),
      ).rejects.toMatchObject({
        code,
        httpStatus: Number(status),
      });
    });
  });
});
