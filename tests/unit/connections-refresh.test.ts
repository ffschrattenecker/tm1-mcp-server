import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConnectionRegistry } from "../../src/connections.js";
import { TM1Client } from "../../src/tm1-client.js";
import { MemorySecretStore } from "../helpers/memory-secret-store.js";

const logger = pino({ level: "silent" });
const CREDS = ["TM1_USER=u", "TM1_PASSWORD=p"];

let root: string;
let clock = 1_700_000_000;

/** Write a `.env` with a distinct mtime, so edits within one test are seen. */
function writeEnv(name: string, lines: string[]): void {
  mkdirSync(join(root, name), { recursive: true });
  const file = join(root, name, ".env");
  writeFileSync(file, lines.join("\n"));
  clock += 10;
  utimesSync(file, clock, clock);
}

function make(env: NodeJS.ProcessEnv = {}, store?: MemorySecretStore) {
  return ConnectionRegistry.fromEnvironment(
    { TM1_CONNECTIONS_DIR: root, ...env },
    logger,
    store ? { secretStore: store } : {},
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tm1-refresh-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("empty registry", () => {
  it("starts with an empty folder and says where to create a connection", async () => {
    const reg = make();
    expect(reg.names).toEqual([]);
    expect(reg.usableNames).toEqual([]);
    expect(reg.dir).toBe(root);
    await expect(reg.get("dev")).rejects.toThrow(
      `No TM1 connection configured under ${root}`,
    );
    await expect(reg.get(undefined)).rejects.toThrow(
      `No TM1 connection configured under ${root}`,
    );
  });

  it("keeps the legacy TM1_BASE_URL mode unchanged", () => {
    const reg = ConnectionRegistry.fromEnvironment(
      { TM1_BASE_URL: "http://x:1", TM1_USER: "u", TM1_PASSWORD: "p" },
      logger,
    );
    expect(reg.names).toEqual(["default"]);
    reg.refresh(); // no folder to rescan
    expect(reg.names).toEqual(["default"]);
  });

  it("still fails at startup when folders exist but none is usable", () => {
    writeEnv("bad", ["TM1_USER=u"]);
    expect(() => make()).toThrow(/No usable TM1 connection/);
  });
});

describe("ConnectionRegistry.refresh", () => {
  it("adds a folder created after startup, also on an unknown name", async () => {
    vi.spyOn(TM1Client.prototype, "connect").mockResolvedValue();
    const reg = make();
    writeEnv("dev", ["TM1_BASE_URL=http://d:1", ...CREDS]);
    reg.refresh();
    expect(reg.usableNames).toEqual(["dev"]);

    writeEnv("test", ["TM1_BASE_URL=http://t:1", ...CREDS]);
    await expect(reg.get("test")).resolves.toBeInstanceOf(TM1Client);
    expect(reg.names).toEqual(["dev", "test"]);
    await expect(reg.get("nope")).rejects.toThrow(/Unknown connection "nope"/);
  });

  it("drops a folder that was removed", () => {
    writeEnv("a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    writeEnv("b", ["TM1_BASE_URL=http://b:1", ...CREDS]);
    const reg = make();
    rmSync(join(root, "b"), { recursive: true });
    reg.refresh();
    expect(reg.names).toEqual(["a"]);
  });

  it("replaces a connection whose .env changed when it has no live session", () => {
    writeEnv("a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    const reg = make();
    expect(reg.info("a")?.baseUrl).toBe("http://a:1");
    writeEnv("a", ["TM1_BASE_URL=http://a2:1", ...CREDS, "TM1_MODE=readwrite"]);
    reg.refresh();
    expect(reg.info("a")?.baseUrl).toBe("http://a2:1");
    expect(reg.info("a")?.mode).toBe("readwrite");
  });

  it("leaves an unchanged connection (and its client) alone", async () => {
    vi.spyOn(TM1Client.prototype, "connect").mockResolvedValue();
    writeEnv("a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    const reg = make();
    const client = await reg.get("a");
    reg.refresh();
    await expect(reg.get("a")).resolves.toBe(client);
  });

  it("does not replace a connection with a live session", async () => {
    vi.spyOn(TM1Client.prototype, "connect").mockResolvedValue();
    vi.spyOn(TM1Client.prototype, "sessionActive", "get").mockReturnValue(true);
    writeEnv("a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    const reg = make();
    const client = await reg.get("a");
    writeEnv("a", ["TM1_BASE_URL=http://a2:1", ...CREDS]);
    reg.refresh();
    expect(reg.info("a")?.baseUrl).toBe("http://a:1");
    await expect(reg.get("a")).resolves.toBe(client);
  });

  it("replaces a misconfigured folder once it is fixed", () => {
    writeEnv("good", ["TM1_BASE_URL=http://g:1", ...CREDS]);
    writeEnv("bad", ["TM1_USER=u"]);
    const reg = make();
    expect(reg.info("bad")?.configError).toBeDefined();
    writeEnv("bad", ["TM1_BASE_URL=http://b:1", ...CREDS]);
    reg.refresh();
    expect(reg.info("bad")?.configError).toBeUndefined();
    expect(reg.usableNames).toEqual(["bad", "good"]);
  });

  it("honours TM1_CONNECTIONS", () => {
    writeEnv("a", ["TM1_BASE_URL=http://a:1", ...CREDS]);
    const reg = make({ TM1_CONNECTIONS: "a" });
    writeEnv("b", ["TM1_BASE_URL=http://b:1", ...CREDS]);
    reg.refresh();
    expect(reg.names).toEqual(["a"]);
  });
});

// One rejected password is one failed login. The latch lifts only when the
// credential inputs differ from the ones the rejected login used.
describe("rejected login latch", () => {
  const realFetch = globalThis.fetch;
  let logins: number;

  beforeEach(() => {
    logins = 0;
    globalThis.fetch = async () => {
      logins++;
      return new Response("", { status: 401, statusText: "Unauthorized" });
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const KEYCHAIN = [
    "TM1_BASE_URL=http://k:1",
    "TM1_USER=u",
    "TM1_SECRETS=keychain",
  ];

  it("keeps the latch while the keychain secret and .env are unchanged", async () => {
    const store = new MemorySecretStore();
    store.set("kc", "TM1_PASSWORD", "wrong");
    writeEnv("kc", KEYCHAIN);
    const reg = make({}, store);

    const first = await reg.get("kc");
    expect(first.loginRejected).toBe(true);
    for (let i = 0; i < 3; i++) {
      await expect(reg.get("kc")).resolves.toBe(first);
    }
    expect(logins).toBe(1);
  });

  it("tries once more after secrets set stores a different secret", async () => {
    const store = new MemorySecretStore();
    store.set("kc", "TM1_PASSWORD", "wrong");
    writeEnv("kc", KEYCHAIN);
    const reg = make({}, store);

    const first = await reg.get("kc");
    expect(logins).toBe(1);

    store.set("kc", "TM1_PASSWORD", "right");
    const second = await reg.get("kc");
    expect(second).not.toBe(first);
    expect(logins).toBe(2);
    // The second rejection is latched again against the new secret.
    await reg.get("kc");
    await reg.get("kc");
    expect(logins).toBe(2);
  });

  it("tries once more after the .env changed", async () => {
    writeEnv("dev", ["TM1_BASE_URL=http://d:1", ...CREDS]);
    const reg = make();
    await reg.get("dev");
    await reg.get("dev");
    expect(logins).toBe(1);

    writeEnv("dev", [
      "TM1_BASE_URL=http://d:1",
      "TM1_USER=u",
      "TM1_PASSWORD=q",
    ]);
    await reg.get("dev");
    expect(logins).toBe(2);
  });

  it("keeps the latch when the keychain cannot be read", async () => {
    const store = new MemorySecretStore();
    store.set("kc", "TM1_PASSWORD", "wrong");
    writeEnv("kc", KEYCHAIN);
    const reg = make({}, store);
    const first = await reg.get("kc");

    vi.spyOn(store, "get").mockImplementation(() => {
      throw new Error("locked");
    });
    await expect(reg.get("kc")).resolves.toBe(first);
    expect(logins).toBe(1);
  });
});
