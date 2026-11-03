// v12 connection layer: TM1HttpClient reroots every outbound request path
// through ConnectionProfile.resolveApiPath(), so a v12 target gets
// `/{instance}/api/v1/Databases('{db}')/...`. v11 is covered by the identity
// reroot in the http-network-error and http-mutation-events tests.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { mockLogger } from "../helpers/client-harness.js";

function makeV12Config(): TM1Config {
  return {
    baseUrl: "http://host:4444",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 60000,
    logLevel: "info",
    tm1Version: "12.0",
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 0,
    httpAllowedOrigins: [],
    mode: "readonly",
    responseMode: "structured",
    maxResponseChars: 80_000,
    version: 12,
    instance: "tm1",
    database: "db1",
    authMode: "s2s",
    clientId: "client-id",
    clientSecret: "client-secret",
  };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue("{}"),
  } as unknown as Response;
}

describe("v12 rerooting: TM1HttpClient prefixes request paths with the database root", () => {
  let client: TM1HttpClient;
  let fetchSpy: FnSpy;

  beforeEach(() => {
    const cfg = makeV12Config();
    const sm = new SessionManager(cfg, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
    client = new TM1HttpClient(cfg, sm, mockLogger);

    fetchSpy = vi.fn().mockResolvedValue(okResponse());
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each<[string, (c: TM1HttpClient) => Promise<unknown>, string]>([
    [
      "request()",
      (c) => c.request("GET", "/api/v1/Cubes('Sales')"),
      "http://host:4444/tm1/api/v1/Databases('db1')/Cubes('Sales')",
    ],
    [
      "requestRaw()",
      (c) => c.requestRaw("GET", "/api/v1/Processes('P1')/ExecuteWithReturn"),
      "http://host:4444/tm1/api/v1/Databases('db1')/Processes('P1')/ExecuteWithReturn",
    ],
    [
      "requestBinary()",
      (c) =>
        c.requestBinary(
          "PUT",
          "/api/v1/Contents('file.blob')/Content",
          new Uint8Array([1, 2, 3]),
        ),
      "http://host:4444/tm1/api/v1/Databases('db1')/Contents('file.blob')/Content",
    ],
  ])(
    "%s rewrites /api/v1/... to the database-rooted path",
    async (_name, call, url) => {
      await call(client);
      expect(fetchSpy.mock.calls.at(-1)![0]).toBe(url);
    },
  );
});
