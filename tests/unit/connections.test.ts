import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConnectionRegistry, connectionEnv } from "../../src/connections.js";

const logger = pino({ level: "silent" });

function writeConn(root: string, name: string, lines: string[]): void {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, ".env"), lines.join("\n"));
}

const CREDS = ["TM1_USER=u", "TM1_PASSWORD=p"];

describe("ConnectionRegistry.fromEnvironment", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tm1-conns-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers one connection per folder with a .env, sorted by name", () => {
    writeConn(root, "zeta", ["TM1_BASE_URL=http://z:1", ...CREDS]);
    writeConn(root, "alpha", [
      "TM1_BASE_URL=http://a:1",
      ...CREDS,
      "TM1_MODE=readwrite",
    ]);
    mkdirSync(join(root, "no-env-here"));

    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root },
      logger,
    );

    expect(reg.names).toEqual(["alpha", "zeta"]);
    expect(reg.isSingle).toBe(false);
    expect(reg.info("alpha")?.mode).toBe("readwrite");
    expect(reg.info("zeta")?.mode).toBe("readonly");
    expect(reg.anyReadwrite).toBe(true);
  });

  // The safety property: a readwrite flag in the launching shell must not arm
  // every connection folder that doesn't set its own mode.
  it("does not inherit connection-level TM1_* keys from the process env", () => {
    writeConn(root, "prod", ["TM1_BASE_URL=http://p:1", ...CREDS]);

    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root, TM1_MODE: "readwrite", TM1_VERSION: "12" },
      logger,
    );

    expect(reg.info("prod")?.mode).toBe("readonly");
    expect(reg.info("prod")?.version).toBe(11);
    expect(reg.anyReadwrite).toBe(false);
  });

  it("applies TM1_ENVIRONMENT=prod per connection folder", () => {
    writeConn(root, "prod", [
      "TM1_BASE_URL=http://p:1",
      ...CREDS,
      "TM1_MODE=readwrite",
      "TM1_ENVIRONMENT=prod",
    ]);
    writeConn(root, "test", [
      "TM1_BASE_URL=http://t:1",
      ...CREDS,
      "TM1_MODE=readwrite",
      "TM1_ENVIRONMENT=test",
    ]);

    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root, TM1_ALLOW_PROD_WRITES: "true" },
      logger,
    );

    expect(reg.info("prod")?.mode).toBe("readonly");
    expect(reg.info("prod")?.environment).toBe("prod");
    expect(reg.info("prod")?.modeReason).toMatch(/prod forces readonly/);
    expect(reg.info("test")?.mode).toBe("readwrite");
    expect(reg.info("test")?.modeReason).toBeUndefined();
  });

  it("narrows discovery with TM1_CONNECTIONS", () => {
    writeConn(root, "a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    writeConn(root, "b", ["TM1_BASE_URL=http://b:1", ...CREDS]);

    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root, TM1_CONNECTIONS: "b" },
      logger,
    );

    expect(reg.names).toEqual(["b"]);
    expect(reg.isSingle).toBe(true);
  });

  it("keeps a misconfigured folder listed but unusable", async () => {
    writeConn(root, "good", ["TM1_BASE_URL=http://g:1", ...CREDS]);
    writeConn(root, "bad", ["TM1_USER=u"]);

    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root },
      logger,
    );

    expect(reg.names).toEqual(["bad", "good"]);
    expect(reg.usableNames).toEqual(["good"]);
    expect(reg.info("bad")?.configError).toMatch(/TM1_BASE_URL/);
    await expect(reg.get("bad")).rejects.toThrow(/misconfigured/);
  });

  it("falls back to a single 'default' connection when TM1_BASE_URL is set", () => {
    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_BASE_URL: "http://x:1", ...{ TM1_USER: "u", TM1_PASSWORD: "p" } },
      logger,
    );

    expect(reg.names).toEqual(["default"]);
    expect(reg.isSingle).toBe(true);
    expect(reg.info("default")?.mode).toBe("readonly");
  });

  it("throws when no connection can be found", () => {
    expect(() =>
      ConnectionRegistry.fromEnvironment(
        { TM1_CONNECTIONS_DIR: join(root, "missing") },
        logger,
      ),
    ).toThrow(/No TM1 connections found/);
  });

  it("requires a connection name when there are several, and rejects unknown ones", async () => {
    writeConn(root, "a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    writeConn(root, "b", ["TM1_BASE_URL=http://b:1", ...CREDS]);
    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root },
      logger,
    );

    await expect(reg.get(undefined)).rejects.toThrow(/connection is required/);
    await expect(reg.get("nope")).rejects.toThrow(/Unknown connection "nope"/);
  });
});

describe("ConnectionRegistry with no usable folder", () => {
  it("fails at startup and names every folder's problem", () => {
    const root = mkdtempSync(join(tmpdir(), "tm1-conns-"));
    try {
      writeConn(root, "a", ["TM1_USER=u"]);
      writeConn(root, "b", [
        "TM1_BASE_URL=http://b:1",
        "TM1_MODE=sideways",
        ...CREDS,
      ]);
      expect(() =>
        ConnectionRegistry.fromEnvironment(
          { TM1_CONNECTIONS_DIR: root },
          logger,
        ),
      ).toThrow(
        /No usable TM1 connection[\s\S]*a: .*TM1_BASE_URL[\s\S]*b: .*TM1_MODE/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("connectionEnv — the one .env reader", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tm1-connenv-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("parses values the way dotenv does: quotes stripped, inline comments dropped", () => {
    writeConn(root, "c", [
      "TM1_USER='quoted user'",
      'TM1_PASSWORD="p#ss word"',
      "TM1_BASE_URL=http://h:1 # the test box",
      "TM1X_DESCRIPTION=plapp environment (franz instance)",
    ]);
    const env = connectionEnv(join(root, "c"), {});
    expect(env.TM1_USER).toBe("quoted user");
    expect(env.TM1_PASSWORD).toBe("p#ss word");
    expect(env.TM1_BASE_URL).toBe("http://h:1");
  });

  it("drops connection-level TM1_* from the shell but keeps server-level and non-TM1 keys", () => {
    writeConn(root, "c", ["TM1_BASE_URL=http://h:1", ...CREDS]);
    const env = connectionEnv(join(root, "c"), {
      TM1_INSTANCE: "leaked",
      TM1_LOG_LEVEL: "debug",
      PATH: "/bin",
    });
    expect(env.TM1_INSTANCE).toBeUndefined();
    expect(env.TM1_LOG_LEVEL).toBe("debug");
    expect(env.PATH).toBe("/bin");
  });

  it("does not let a folder override server-level settings", () => {
    writeConn(root, "c", ["TM1_LOG_LEVEL=trace", "TM1_MCP_TRANSPORT=http"]);
    const env = connectionEnv(join(root, "c"), { TM1_LOG_LEVEL: "info" });
    expect(env.TM1_LOG_LEVEL).toBe("info");
    expect(env.TM1_MCP_TRANSPORT).toBeUndefined();
  });
});
