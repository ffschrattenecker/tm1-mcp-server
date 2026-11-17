// SandboxService: the /api/v1/Sandboxes calls, ServerService.isSandboxingDisabled,
// and the post-login read of DisableSandboxing that TM1Client keeps.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { mockLogger } from "../helpers/client-harness.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { SandboxService } from "../../src/tm1-client/services/sandbox-service.js";
import { ServerService } from "../../src/tm1-client/services/server-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

// Every stubbed request goes through the recorded wire contracts, as in the
// other service tests.
function fakeHttp(
  respond: (method: string, path: string) => unknown = () => undefined,
) {
  const calls: Call[] = [];
  const http = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return respond(method, path);
    }),
  } as unknown as TM1HttpClient;
  return { http: contractCheckedHttp(http), calls };
}

describe("SandboxService", () => {
  it("list maps the state flags and reports a missing flag as null", async () => {
    const { http, calls } = fakeHttp(() => ({
      value: [
        {
          Name: "mcp-alice",
          IncludeInSandboxDimension: true,
          IsActive: false,
          IsLoaded: true,
        },
        { Name: "mcp-bob" },
      ],
    }));
    const svc = new SandboxService(http);

    const list = await svc.list();

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/Sandboxes", body: undefined },
    ]);
    expect(list).toEqual([
      {
        name: "mcp-alice",
        includeInSandboxDimension: true,
        isActive: false,
        isLoaded: true,
        isQueued: null,
      },
      {
        name: "mcp-bob",
        includeInSandboxDimension: null,
        isActive: null,
        isLoaded: null,
        isQueued: null,
      },
    ]);
  });

  it("list returns an empty array when TM1 sends no value", async () => {
    const { http } = fakeHttp(() => ({}));
    expect(await new SandboxService(http).list()).toEqual([]);
  });

  it("create POSTs the name and IncludeInSandboxDimension, defaulting the flag to true", async () => {
    const { http, calls } = fakeHttp();
    const svc = new SandboxService(http);

    await svc.create("mcp-alice");
    await svc.create("mcp-bob", false);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/Sandboxes",
        body: { Name: "mcp-alice", IncludeInSandboxDimension: true },
      },
      {
        method: "POST",
        path: "/api/v1/Sandboxes",
        body: { Name: "mcp-bob", IncludeInSandboxDimension: false },
      },
    ]);
  });

  it("publish, discard and delete address the sandbox by its OData-escaped name", async () => {
    const { http, calls } = fakeHttp();
    const svc = new SandboxService(http);
    const name = "mcp-it's";

    await svc.publish(name);
    await svc.discardChanges(name);
    await svc.delete(name);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/Sandboxes('mcp-it''s')/tm1.Publish",
        body: {},
      },
      {
        method: "POST",
        path: "/api/v1/Sandboxes('mcp-it''s')/tm1.DiscardChanges",
        body: {},
      },
      {
        method: "DELETE",
        path: "/api/v1/Sandboxes('mcp-it''s')",
        body: undefined,
      },
    ]);
  });
});

describe("ServerService.isSandboxingDisabled", () => {
  function serverWith(respond: () => unknown) {
    const { http, calls } = fakeHttp(respond);
    return { server: new ServerService(http), calls };
  }

  it("reads DisableSandboxing from /Configuration, not /ActiveConfiguration", async () => {
    const { server, calls } = serverWith(() => ({ DisableSandboxing: true }));

    await server.isSandboxingDisabled();

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/Configuration", body: undefined },
    ]);
  });

  it("returns true when the setting is T", async () => {
    const { server } = serverWith(() => ({ DisableSandboxing: true }));
    expect(await server.isSandboxingDisabled()).toBe(true);
  });

  it("returns false when the setting is F", async () => {
    const { server } = serverWith(() => ({ DisableSandboxing: false }));
    expect(await server.isSandboxingDisabled()).toBe(false);
  });

  it("returns undefined when the field is missing (TM1 12)", async () => {
    const { server } = serverWith(() => ({ ServerName: "s" }));
    expect(await server.isSandboxingDisabled()).toBeUndefined();
  });

  it("returns undefined when the field is not a boolean", async () => {
    const { server } = serverWith(() => ({ DisableSandboxing: "T" }));
    expect(await server.isSandboxingDisabled()).toBeUndefined();
  });

  it("returns undefined instead of throwing when the request fails", async () => {
    const http = {
      request: vi.fn(async () => {
        throw new Error("ObjectSecurityNoAdminRights");
      }),
    } as unknown as TM1HttpClient;
    const server = new ServerService(http);

    await expect(server.isSandboxingDisabled()).resolves.toBeUndefined();
  });
});

describe("TM1Client post-login read of DisableSandboxing", () => {
  let fetchSpy: FnSpy;
  // The /Configuration reply for the next call; a test swaps it between logins.
  let configuration: () => Response;

  function jsonResponse(
    body: unknown,
    opts: { status?: number; setCookie?: string } = {},
  ): Response {
    const headers = new Headers();
    if (opts.setCookie) headers.set("set-cookie", opts.setCookie);
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers,
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.mocked(mockLogger.warn).mockClear();
    configuration = () => jsonResponse({ DisableSandboxing: true });
    fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/Configuration/ProductVersion")) {
        return jsonResponse(
          { value: "11.8.0" },
          { setCookie: "TM1SessionId=session-1; Path=/" },
        );
      }
      if (url.endsWith("/api/v1/Configuration")) return configuration();
      return jsonResponse({});
    });
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const config = makeTestConfig({ requestTimeoutMs: 5000 });
    const sm = new SessionManager(config, mockLogger);
    vi.spyOn(sm, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sm, "stopKeepAlive").mockImplementation(() => {});
    return { client: new TM1Client(config, sm, mockLogger), sm };
  }

  it("sets sandboxingDisabled after the first login", async () => {
    const { client } = setup();
    expect(client.sandboxingDisabled).toBeUndefined();

    await client.connect();

    await vi.waitFor(() => expect(client.sandboxingDisabled).toBe(true));
  });

  it("reads the setting again after a re-login", async () => {
    const { client, sm } = setup();
    await client.connect();
    await vi.waitFor(() => expect(client.sandboxingDisabled).toBe(true));

    configuration = () => jsonResponse({ DisableSandboxing: false });
    await sm.authenticate();

    await vi.waitFor(() => expect(client.sandboxingDisabled).toBe(false));
  });

  it("stays undefined when the read fails, and the login still succeeds", async () => {
    configuration = () =>
      jsonResponse({ error: { code: "x", message: "y" } }, { status: 500 });
    const { client } = setup();

    await expect(client.connect()).resolves.toBeUndefined();

    expect(client.isConnected()).toBe(true);
    await vi.waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/Configuration$/),
        expect.anything(),
      ),
    );
    // Let the fire-and-forget read settle before asserting on its outcome.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sandboxingDisabled).toBeUndefined();
  });

  it("a throwing onLogin hook is logged and does not fail the login", async () => {
    const sm = new SessionManager(
      makeTestConfig({ requestTimeoutMs: 5000 }),
      mockLogger,
    );
    sm.onLogin = () => {
      throw new Error("hook exploded");
    };

    await expect(sm.authenticate()).resolves.toBe("session-1");

    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("Post-login hook failed"),
      ),
    );
  });
});
