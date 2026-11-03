import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connectionIdOf, loadConfig } from "../../src/config.js";

const REQUIRED = {
  TM1_BASE_URL: "https://tm1server:8010",
  TM1_USER: "admin",
  TM1_PASSWORD: "secret",
};

const SAAS = {
  TM1_BASE_URL: "https://region.example.com",
  TM1_AUTH_MODE: "saas",
  TM1_TENANT: "T3NANT",
  TM1_DATABASE: "db1",
  TM1_API_KEY: "k3y",
};

const S2S = {
  TM1_BASE_URL: "http://host:4444",
  TM1_USER: "admin",
  TM1_PASSWORD: "x",
  TM1_INSTANCE: "tm1",
  TM1_DATABASE: "db1",
  TM1_AUTH_MODE: "s2s",
  TM1_CLIENT_ID: "cid",
  TM1_CLIENT_SECRET: "csec",
};

function omit(base: Record<string, string>, ...keys: string[]) {
  return Object.fromEntries(
    Object.entries(base).filter(([k]) => !keys.includes(k)),
  );
}

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("TM1_")) delete process.env[key];
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("applies defaults and reads the required vars from the env record", () => {
    const config = loadConfig(REQUIRED);

    expect(config.baseUrl).toBe("https://tm1server:8010");
    expect(config.user).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.ssl.rejectUnauthorized).toBe(true);
    expect(config.keepAliveIntervalMs).toBe(60000);
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.logLevel).toBe("info");
    expect(config.logFile).toBeUndefined();
    expect(config.httpToken).toBeUndefined();
    expect(config.namespace).toBeUndefined();
    expect(config.camPassport).toBeUndefined();
    expect(config.version).toBe(11);
    // Not cosmetic: "structured" drops content[0].text, and a client that reads
    // only content[] (Kiro's IDE MCP layer does exactly that) then renders an
    // empty result. The default has to stay on the shape every client can read.
    expect(config.responseMode).toBe("legacy");
  });

  it("reads process.env when no record is given", () => {
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "secret";
    process.env.TM1_MODE = "readwrite";
    expect(loadConfig().mode).toBe("readwrite");
  });

  it("reads an explicit env record and ignores process.env", () => {
    process.env.TM1_ENVIRONMENT = "dev";
    const c = loadConfig({
      ...REQUIRED,
      TM1_MODE: "readwrite",
      TM1_ENVIRONMENT: "prod",
    });
    expect(c.environment).toBe("prod");
    expect(c.mode).toBe("readonly");
  });

  describe("parses valid settings", () => {
    // prettier-ignore
    it.each<[string, Record<string, string>, object]>([
      ["SSL=false", { TM1_SSL_REJECT_UNAUTHORIZED: "false" }, { ssl: { rejectUnauthorized: false } }],
      ["SSL=true", { TM1_SSL_REJECT_UNAUTHORIZED: "true" }, { ssl: { rejectUnauthorized: true } }],
      ["keep-alive interval", { TM1_KEEP_ALIVE_INTERVAL: "120000" }, { keepAliveIntervalMs: 120000 }],
      ["request timeout", { TM1_REQUEST_TIMEOUT: "5000" }, { requestTimeoutMs: 5000 }],
      ["log file", { TM1_LOG_FILE: "/var/log/tm1-mcp.log" }, { logFile: "/var/log/tm1-mcp.log" }],
      ["empty log file is unset", { TM1_LOG_FILE: "" }, { logFile: undefined }],
      ["HTTP token", { TM1_MCP_HTTP_TOKEN: "s3cret" }, { httpToken: "s3cret" }],
      ["CAM namespace", { TM1_NAMESPACE: "LDAP" }, { namespace: "LDAP" }],
      ["empty CAM namespace is unset", { TM1_NAMESPACE: "" }, { namespace: undefined }],
      ["SOCKS5 proxy", { TM1_PROXY: "socks5://proxy.example.com:1080" }, { proxy: "socks5://proxy.example.com:1080" }],
      ["SOCKS5h proxy", { TM1_PROXY: "socks5h://proxy.example.com:1080" }, { proxy: "socks5h://proxy.example.com:1080" }],
      ["log level debug", { TM1_LOG_LEVEL: "debug" }, { logLevel: "debug" }],
      ["log level warn", { TM1_LOG_LEVEL: "warn" }, { logLevel: "warn" }],
      ["log level error", { TM1_LOG_LEVEL: "error" }, { logLevel: "error" }],
      ["log level is case-insensitive", { TM1_LOG_LEVEL: "Debug" }, { logLevel: "debug" }],
      ["transport is case-insensitive", { TM1_MCP_TRANSPORT: "HTTP" }, { transport: "http" }],
    ])("%s", (_name, overrides, expected) => {
      expect(loadConfig({ ...REQUIRED, ...overrides })).toMatchObject(expected);
    });
  });

  describe("rejects invalid settings", () => {
    // prettier-ignore
    it.each<[string, Record<string, string>, RegExp | string]>([
      ["non-SOCKS5 proxy", { TM1_PROXY: "http://proxy.example.com:8080" }, /TM1_PROXY must be a socks5/],
      ["malformed proxy", { TM1_PROXY: "not a url" }, /TM1_PROXY must be a socks5/],
      ["non-numeric keep-alive", { TM1_KEEP_ALIVE_INTERVAL: "abc" }, "Invalid TM1_KEEP_ALIVE_INTERVAL"],
      ["non-positive timeout", { TM1_REQUEST_TIMEOUT: "0" }, "Invalid TM1_REQUEST_TIMEOUT"],
      ["non-numeric HTTP port", { TM1_MCP_HTTP_PORT: "NaN" }, "Invalid TM1_MCP_HTTP_PORT"],
      ["unknown log level", { TM1_LOG_LEVEL: "verbose" }, /Invalid TM1_LOG_LEVEL/],
      ["unknown transport", { TM1_MCP_TRANSPORT: "htttp" }, /Invalid TM1_MCP_TRANSPORT/],
      ["unknown environment", { TM1_ENVIRONMENT: "production" }, /Invalid TM1_ENVIRONMENT/],
    ])("%s", (_name, overrides, message) => {
      expect(() => loadConfig({ ...REQUIRED, ...overrides })).toThrow(message);
    });
  });

  // prettier-ignore
  it.each<[string, Record<string, string>, string]>([
    ["TM1_BASE_URL", omit(REQUIRED, "TM1_BASE_URL"), "TM1_BASE_URL"],
    ["TM1_USER", omit(REQUIRED, "TM1_USER"), "TM1_USER"],
    ["TM1_PASSWORD", omit(REQUIRED, "TM1_PASSWORD"), "TM1_PASSWORD"],
    ["all three", {}, "TM1_BASE_URL, TM1_USER, TM1_PASSWORD"],
    ["user/password in CAM namespace mode", { TM1_BASE_URL: REQUIRED.TM1_BASE_URL, TM1_NAMESPACE: "LDAP" }, "TM1_USER, TM1_PASSWORD"],
  ])("requires the env vars: missing %s", (_name, env, missing) => {
    expect(() => loadConfig(env)).toThrow(
      `Missing or empty required environment variables: ${missing}`,
    );
  });

  it("parses TM1_CAM_PASSPORT and does not require user/password", () => {
    const config = loadConfig({
      TM1_BASE_URL: "https://tm1server:8010",
      TM1_CAM_PASSPORT: "MTszMDk6...",
    });
    expect(config.camPassport).toBe("MTszMDk6...");
    expect(config.user).toBe("");
    expect(config.password).toBe("");
  });

  describe("TM1_ENVIRONMENT", () => {
    it("is undefined when unset and leaves TM1_MODE alone", () => {
      const c = loadConfig({ ...REQUIRED, TM1_MODE: "readwrite" });
      expect(c.environment).toBeUndefined();
      expect(c.mode).toBe("readwrite");
      expect(c.modeReason).toBeUndefined();
    });

    it("forces prod to readonly and says why", () => {
      const c = loadConfig({
        ...REQUIRED,
        TM1_MODE: "readwrite",
        TM1_ENVIRONMENT: "Prod",
      });
      expect(c.environment).toBe("prod");
      expect(c.mode).toBe("readonly");
      expect(c.modeReason).toContain("TM1_ALLOW_PROD_WRITES");
    });

    it("keeps prod readwrite with TM1_ALLOW_PROD_WRITES=true", () => {
      const c = loadConfig({
        ...REQUIRED,
        TM1_MODE: "readwrite",
        TM1_ENVIRONMENT: "prod",
        TM1_ALLOW_PROD_WRITES: "true",
      });
      expect(c.mode).toBe("readwrite");
      expect(c.modeReason).toBeUndefined();
    });

    it("does not touch dev", () => {
      expect(
        loadConfig({
          ...REQUIRED,
          TM1_MODE: "readwrite",
          TM1_ENVIRONMENT: "dev",
        }).mode,
      ).toBe("readwrite");
    });
  });

  describe("non-loopback HTTP bind requires TM1_MCP_HTTP_TOKEN", () => {
    const http = { ...REQUIRED, TM1_MCP_TRANSPORT: "http" };

    it("throws for a 0.0.0.0 or LAN bind without a token", () => {
      expect(() =>
        loadConfig({ ...http, TM1_MCP_HTTP_HOST: "0.0.0.0" }),
      ).toThrow(/TM1_MCP_HTTP_TOKEN/);
      expect(() =>
        loadConfig({ ...http, TM1_MCP_HTTP_HOST: "192.168.1.10" }),
      ).toThrow(/not loopback/);
    });

    it("allows a non-loopback bind when a token is set", () => {
      const c = loadConfig({
        ...http,
        TM1_MCP_HTTP_HOST: "0.0.0.0",
        TM1_MCP_HTTP_TOKEN: "s3cret",
      });
      expect(c.httpHost).toBe("0.0.0.0");
    });

    it("keeps warn-only behaviour for loopback binds without a token", () => {
      for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1"]) {
        expect(loadConfig({ ...http, TM1_MCP_HTTP_HOST: host }).httpHost).toBe(
          host,
        );
      }
    });

    it("does not throw for stdio transport even with a non-loopback host set", () => {
      const c = loadConfig({ ...REQUIRED, TM1_MCP_HTTP_HOST: "0.0.0.0" });
      expect(c.transport).toBe("stdio");
    });
  });

  describe("v12 connection config", () => {
    // prettier-ignore
    it.each<[string, Record<string, string>, Record<string, unknown>]>([
      ["saas with tenant, database and API key", SAAS, { version: 12, authMode: "saas", tenant: "T3NANT" }],
      ["s2s with instance, database and creds", S2S, { version: 12, instance: "tm1", database: "db1", authMode: "s2s", clientId: "cid", clientSecret: "csec", }],
      ["s2s with no TM1_PASSWORD (password is not sent)", omit(S2S, "TM1_PASSWORD"), { version: 12, authMode: "s2s", password: "" }],
      ["access_token with no TM1_PASSWORD", { TM1_BASE_URL: "http://host:4444", TM1_USER: "admin", TM1_INSTANCE: "tm1", TM1_DATABASE: "db1", TM1_AUTH_MODE: "access_token", TM1_ACCESS_TOKEN: "tok", }, { authMode: "access_token" }],
      ["s2s aligns tm1Version to 12.0 when TM1_VERSION is unset", S2S, { version: 12, tm1Version: "12.0" }],
      ["explicit TM1_VERSION=12 is kept", { ...S2S, TM1_VERSION: "12" }, { version: 12, tm1Version: "12" }, ], // Split-brain: instance/database select v12, so a v11 TM1_VERSION must // not leave tm1Version saying 11.8 while version is 12. [ "v11 TM1_VERSION is coerced to 12.0 when instance/database are set", { ...S2S, TM1_VERSION: "11.8" }, { version: 12, tm1Version: "12.0" }],
    ])("loads %s", (_name, env, expected) => {
      expect(loadConfig(env)).toMatchObject(expected);
    });

    it("stays version 11 when no instance/database is set", () => {
      expect(loadConfig(REQUIRED).version).toBe(11);
    });

    it("defers the saas api key to the keychain", () => {
      const env = omit(SAAS, "TM1_API_KEY");
      expect(() => loadConfig(env)).toThrow(/TM1_API_KEY/);
      expect(loadConfig(env, { deferSecrets: true }).tenant).toBe("T3NANT");
    });

    it("keeps two tenants with the same database apart", () => {
      const id = (tenant: string) =>
        connectionIdOf({
          baseUrl: "https://region.example.com",
          tenant,
          database: "db1",
        });
      expect(id("A")).not.toBe(id("B"));
    });

    // Every v12 auth mode sends `{ User: config.user }` in the session login
    // body (profile.ts buildLoginRequest), so TM1_USER is required even for
    // credential modes. TM1_PASSWORD is the opposite: basic mode sends it
    // (buildBasicToken), so it must still fail loudly rather than surface later
    // as a 401. The exemption is keyed on the auth mode, not on "this is v12".
    // prettier-ignore
    it.each<[string, Record<string, string>, RegExp]>([
      ["saas without TM1_TENANT", omit(SAAS, "TM1_TENANT"), /TM1_TENANT/],
      ["saas without TM1_DATABASE", omit(SAAS, "TM1_DATABASE"), /TM1_DATABASE/],
      ["saas without TM1_API_KEY", omit(SAAS, "TM1_API_KEY"), /TM1_API_KEY/],
      ["instance without TM1_DATABASE", omit(S2S, "TM1_DATABASE"), /TM1_DATABASE/],
      ["s2s without TM1_CLIENT_SECRET", omit(S2S, "TM1_CLIENT_SECRET"), /TM1_CLIENT_SECRET/],
      ["s2s without TM1_USER", omit(S2S, "TM1_USER"), /TM1_USER/],
      ["basic without TM1_PASSWORD", { TM1_BASE_URL: "http://host:4444", TM1_USER: "admin", TM1_INSTANCE: "tm1", TM1_DATABASE: "db1", TM1_AUTH_MODE: "basic", }, /TM1_PASSWORD/],
      ["unknown TM1_AUTH_MODE", { ...S2S, TM1_AUTH_MODE: "banana" }, /TM1_AUTH_MODE/],
    ])("rejects %s", (_name, env, message) => {
      expect(() => loadConfig(env)).toThrow(message);
    });
  });
});
