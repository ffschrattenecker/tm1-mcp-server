import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { TM1Config } from "../../src/config.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { TM1Client } from "../../src/tm1-client.js";
import { MemorySecretStore } from "../helpers/memory-secret-store.js";

const logger = pino({ level: "silent" });

function writeConn(root: string, name: string, lines: string[]): void {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, ".env"), lines.join("\n"));
}

function configOf(client: TM1Client): TM1Config {
  return (client as unknown as { config: TM1Config }).config;
}

const KEYCHAIN_CONN = [
  "TM1_BASE_URL=http://k:1",
  "TM1_USER=u",
  "TM1_SECRETS=keychain",
];

describe("ConnectionRegistry with TM1_SECRETS=keychain", () => {
  let root: string;
  let store: MemorySecretStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tm1-kc-"));
    store = new MemorySecretStore();
    vi.spyOn(TM1Client.prototype, "connect").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function registry(env: NodeJS.ProcessEnv = {}): ConnectionRegistry {
    return ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root, ...env },
      logger,
      { secretStore: store },
    );
  }

  // Listing connections must not touch the keychain (macOS may prompt).
  it("discovers the connection without reading the keychain", () => {
    writeConn(root, "kc", KEYCHAIN_CONN);
    const reg = registry();
    expect(reg.usableNames).toEqual(["kc"]);
    expect(reg.info("kc")?.secrets).toBe("keychain");
    expect(store.reads).toBe(0);
  });

  it("reads the secrets on first use and logs in with them", async () => {
    writeConn(root, "kc", KEYCHAIN_CONN);
    store.set("kc", "TM1_PASSWORD", "from-keychain");
    const reg = registry();

    const client = await reg.get("kc");

    expect(configOf(client).password).toBe("from-keychain");
    expect(TM1Client.prototype.connect).toHaveBeenCalledTimes(1);
  });

  it("shares one keychain read between concurrent first calls", async () => {
    writeConn(root, "kc", KEYCHAIN_CONN);
    store.set("kc", "TM1_PASSWORD", "p");
    const reg = registry();

    const [a, b] = await Promise.all([reg.get("kc"), reg.get("kc")]);

    expect(a).toBe(b);
    expect(store.reads).toBe(5); // one pass over the five secret keys
  });

  it("fails that connection with a fix-it hint when the entry is missing", async () => {
    writeConn(root, "kc", KEYCHAIN_CONN);
    const reg = registry();

    await expect(reg.get("kc")).rejects.toThrow(
      /TM1_PASSWORD.*secrets set kc/s,
    );
    expect(reg.status()[0]?.lastError).toMatch(/TM1_PASSWORD/);
    expect(TM1Client.prototype.connect).not.toHaveBeenCalled();

    // Not cached: storing the entry makes the next call work.
    store.set("kc", "TM1_PASSWORD", "p");
    await expect(reg.get("kc")).resolves.toBeInstanceOf(TM1Client);
  });

  it("marks a folder misconfigured when it mixes the marker with a plaintext secret", async () => {
    writeConn(root, "kc", [...KEYCHAIN_CONN, "TM1_PASSWORD=stale"]);
    writeConn(root, "ok", [
      "TM1_BASE_URL=http://o:1",
      "TM1_USER=u",
      "TM1_PASSWORD=p",
    ]);
    const reg = registry();

    expect(reg.info("kc")?.configError).toMatch(/still sets TM1_PASSWORD/);
    await expect(reg.get("kc")).rejects.toThrow(/misconfigured/);
  });

  it("leaves plaintext connections alone and warns about them once", () => {
    writeConn(root, "a", [
      "TM1_BASE_URL=http://a:1",
      "TM1_USER=u",
      "TM1_PASSWORD=p",
    ]);
    writeConn(root, "b", [
      "TM1_BASE_URL=http://b:1",
      "TM1_USER=u",
      "TM1_PASSWORD=p",
    ]);
    writeConn(root, "kc", KEYCHAIN_CONN);
    const warn = vi.fn();
    const spyLogger = { ...logger, warn } as unknown as pino.Logger;

    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_CONNECTIONS_DIR: root },
      spyLogger,
      { secretStore: store },
    );

    expect(reg.info("a")?.secrets).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ connections: ["a", "b"] });
  });

  it("supports the legacy single connection from the process env", async () => {
    store.set("default", "TM1_PASSWORD", "p");
    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_BASE_URL: "http://d:1", TM1_USER: "u", TM1_SECRETS: "keychain" },
      logger,
      { secretStore: store },
    );
    expect(configOf(await reg.get(undefined)).password).toBe("p");
  });
});
