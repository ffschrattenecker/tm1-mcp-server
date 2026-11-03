import { describe, it, expect, vi } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import { createConnectionProfile } from "../../src/tm1-client/connection/profile.js";
import type { TM1Config } from "../../src/config.js";

function baseConfig(overrides: Partial<TM1Config>): TM1Config {
  return {
    baseUrl: "http://host:4444",
    user: "admin",
    password: "",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 30000,
    logLevel: "info",
    tm1Version: "12",
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    httpAllowedOrigins: [],
    mode: "readonly",
    version: 11,
    ...overrides,
  } as TM1Config;
}

const v12Config = (o: Partial<TM1Config> = {}) =>
  baseConfig({
    version: 12,
    instance: "tm1",
    database: "db1",
    authMode: "s2s",
    clientId: "c",
    clientSecret: "s",
    ...o,
  });

describe("resolveApiPath", () => {
  it("is identity for v11", () => {
    const p = createConnectionProfile(baseConfig({ version: 11 }));
    expect(p.resolveApiPath("/api/v1/Cubes('x')")).toBe("/api/v1/Cubes('x')");
  });

  it("reroots v12 paths under the database", () => {
    const p = createConnectionProfile(v12Config());
    expect(p.resolveApiPath("/api/v1/Cubes('x')")).toBe(
      "/tm1/api/v1/Databases('db1')/Cubes('x')",
    );
    expect(p.resolveApiPath("/api/v1/ActiveSession")).toBe(
      "/tm1/api/v1/Databases('db1')/ActiveSession",
    );
  });

  // The instance/database segments are escaped, and the replacement is a
  // literal string: a raw String.replace would read "$&" in the root as a
  // replacement pattern.
  it.each<[string, Partial<TM1Config>, string]>([
    [
      "apostrophe in database name is OData-escaped",
      { database: "d'b" },
      "/tm1/api/v1/Databases('d''b')/Cubes('Sales')",
    ],
    [
      "reserved characters in instance are URL-encoded",
      { instance: "my instance$1" },
      "/my%20instance%241/api/v1/Databases('db1')/Cubes('Sales')",
    ],
    [
      "$-replacement characters in instance are literal",
      { instance: "$&" },
      "/%24%26/api/v1/Databases('db1')/Cubes('Sales')",
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(
      createConnectionProfile(v12Config(overrides)).resolveApiPath(
        "/api/v1/Cubes('Sales')",
      ),
    ).toBe(expected);
  });
});

describe("v12 buildLoginRequest", () => {
  const v12 = (o: Partial<TM1Config>) =>
    createConnectionProfile(v12Config({ user: "admin", ...o }));

  it.each<[string, Partial<TM1Config>, string]>([
    [
      "s2s: Basic(client:secret)",
      { authMode: "s2s", clientId: "cid", clientSecret: "csec" },
      "Basic " + Buffer.from("cid:csec").toString("base64"),
    ],
    [
      "basic (native): Basic(user:password)",
      { authMode: "basic", password: "pw" },
      "Basic " + Buffer.from("admin:pw").toString("base64"),
    ],
    [
      "access_token: Bearer token",
      { authMode: "access_token", accessToken: "tok123" },
      "Bearer tok123",
    ],
    [
      "oidc: Bearer token",
      { authMode: "oidc", accessToken: "tok456" },
      "Bearer tok456",
    ],
    [
      "iam: exchanges api_key for a bearer token",
      { authMode: "iam", apiKey: "key", iamUrl: "https://iam/token" },
      "Bearer iam-tok",
    ],
  ])("%s", async (_name, overrides, authorization) => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "iam-tok" }),
      text: async () => "",
    });
    stubContractCheckedFetch(fetchSpy);
    try {
      const req = await v12(overrides).buildLoginRequest();
      expect(req.method).toBe("POST");
      expect(req.url).toBe("http://host:4444/tm1/auth/v1/session");
      expect(req.headers["Content-Type"]).toBe("application/json");
      expect(req.headers.Authorization).toBe(authorization);
      expect(req.body).toBe(JSON.stringify({ User: "admin" }));
      if (overrides.authMode === "iam") {
        expect(fetchSpy).toHaveBeenCalledWith(
          "https://iam/token",
          expect.objectContaining({ method: "POST" }),
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("saas: tenant-rooted paths, Basic GET as apikey, no session POST", async () => {
    const p = createConnectionProfile(
      baseConfig({
        version: 12,
        authMode: "saas",
        tenant: "T3NANT",
        database: "Plan Db",
        apiKey: "k3y",
        baseUrl: "https://region.example.com",
      }),
    );
    expect(p.resolveApiPath("/api/v1/Cubes")).toBe(
      "/api/T3NANT/v0/tm1/Plan%20Db/api/v1/Cubes",
    );
    const req = await p.buildLoginRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://region.example.com/api/T3NANT/v0/tm1/Plan%20Db/api/v1/Configuration/ProductVersion",
    );
    expect(req.headers.Authorization).toBe(
      "Basic " + Buffer.from("apikey:k3y").toString("base64"),
    );
    expect(req.body).toBeUndefined();
  });
});
