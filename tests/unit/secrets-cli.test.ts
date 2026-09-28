import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import {
  runSecretsCli,
  stripPipedInput,
  type CliIo,
} from "../../src/secrets-cli.js";
import type { SecretKey, SecretStore } from "../../src/secrets.js";
import { MemorySecretStore } from "../helpers/memory-secret-store.js";

describe("tm1-mcp-server secrets", () => {
  let root: string;
  let store: MemorySecretStore;
  let out: string[];
  let err: string[];
  let typed: string;

  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: () => Promise.resolve(typed),
  };

  function envFile(name = "c"): string {
    return join(root, name, ".env");
  }

  function writeEnv(text: string, name = "c"): void {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(envFile(name), text);
  }

  function run(...args: string[]): Promise<number> {
    return runSecretsCli(args, { TM1_CONNECTIONS_DIR: root }, io, store);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tm1-secrets-cli-"));
    store = new MemorySecretStore();
    out = [];
    err = [];
    typed = "typed-secret";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints usage and exits 2 without a command", async () => {
    expect(await run()).toBe(2);
    expect(out.join("\n")).toMatch(/Usage: tm1-mcp-server secrets/);
  });

  it("rejects an unknown connection, key or command", async () => {
    writeEnv("TM1_BASE_URL=http://h:1\n");
    expect(await run("set", "nope")).toBe(2);
    expect(err.pop()).toMatch(/No connection "nope"/);
    expect(await run("set", "c", "TM1_USER")).toBe(2);
    expect(err.pop()).toMatch(/Unknown KEY "TM1_USER"/);
    expect(await run("frobnicate", "c")).toBe(2);
    expect(err.pop()).toMatch(/Unknown command/);
  });

  describe("set / list / delete", () => {
    beforeEach(() =>
      writeEnv("TM1_BASE_URL=http://h:1\nTM1_SECRETS=keychain\n"),
    );

    it("stores TM1_PASSWORD by default, never echoing it", async () => {
      expect(await run("set", "c")).toBe(0);
      expect(store.get("c", "TM1_PASSWORD")).toBe("typed-secret");
      expect(out.join("\n")).not.toContain("typed-secret");
    });

    it("stores the named key", async () => {
      expect(await run("set", "c", "TM1_CLIENT_SECRET")).toBe(0);
      expect(store.get("c", "TM1_CLIENT_SECRET")).toBe("typed-secret");
    });

    it("refuses an empty value", async () => {
      typed = "";
      expect(await run("set", "c")).toBe(1);
      expect(store.entries.size).toBe(0);
    });

    it("refuses a multi-line value", async () => {
      typed = "pw\r\nextra";
      expect(await run("set", "c")).toBe(1);
      expect(err.pop()).toMatch(/several lines/);
      expect(store.entries.size).toBe(0);
    });

    it("strips a BOM and one trailing newline from piped input", () => {
      expect(stripPipedInput("\uFEFFpw\r\n")).toBe("pw");
      expect(stripPipedInput("pw\n\n")).toBe("pw\n");
    });

    it("warns when the .env lacks the keychain marker", async () => {
      writeEnv("TM1_BASE_URL=http://h:1\n", "plain");
      expect(await run("set", "plain")).toBe(0);
      expect(out.join("\n")).toMatch(/does not set TM1_SECRETS=keychain/);
    });

    it("lists which keys are stored without their values", async () => {
      store.set("c", "TM1_PASSWORD", "hidden");
      expect(await run("list", "c")).toBe(0);
      expect(out.join("\n")).toMatch(/TM1_PASSWORD\s+stored/);
      expect(out.join("\n")).toMatch(/TM1_API_KEY\s+-/);
      expect(out.join("\n")).not.toContain("hidden");
    });

    it("deletes one key or all of them", async () => {
      store.set("c", "TM1_PASSWORD", "p");
      store.set("c", "TM1_API_KEY", "k");
      expect(await run("delete", "c", "TM1_API_KEY")).toBe(0);
      expect(store.entries.has("c/TM1_API_KEY")).toBe(false);
      expect(await run("delete", "c", "TM1_API_KEY")).toBe(0);
      expect(out.pop()).toMatch(/No entry/);
      expect(await run("delete", "c")).toBe(0);
      expect(store.entries.size).toBe(0);
    });
  });

  describe("migrate", () => {
    it("moves the secrets into the keychain and rewrites the .env", async () => {
      writeEnv(
        [
          "# dev server",
          "TM1_BASE_URL=http://h:1",
          "TM1_USER=admin",
          'TM1_PASSWORD="p#ss word"',
          "TM1_MODE=readwrite",
          "",
        ].join("\r\n"),
      );

      expect(await run("migrate", "c")).toBe(0);

      expect(store.get("c", "TM1_PASSWORD")).toBe("p#ss word");
      const text = readFileSync(envFile(), "utf8");
      expect(text).not.toContain("p#ss word");
      expect(text).toContain("# dev server\r\n"); // comments and CRLF kept
      expect(parseDotenv(text)).toEqual({
        TM1_BASE_URL: "http://h:1",
        TM1_USER: "admin",
        TM1_MODE: "readwrite",
        TM1_SECRETS: "keychain",
      });
      expect(existsSync(`${envFile()}.tmp`)).toBe(false);
    });

    it("keeps a blank password line: it is no secret", async () => {
      writeEnv("TM1_BASE_URL=http://h:1\nTM1_USER=admin\nTM1_PASSWORD=\n");
      expect(await run("migrate", "c")).toBe(0);
      expect(out.pop()).toMatch(/no plaintext secret/);
      expect(readFileSync(envFile(), "utf8")).toContain("TM1_PASSWORD=");
    });

    it("moves every secret key and replaces an existing marker", async () => {
      writeEnv(
        "TM1_BASE_URL=http://h:1\nTM1_SECRETS=keychain\nexport TM1_CLIENT_SECRET=cs\nTM1_API_KEY='k'\n",
      );
      expect(await run("migrate", "c")).toBe(0);
      expect(store.get("c", "TM1_CLIENT_SECRET")).toBe("cs");
      expect(store.get("c", "TM1_API_KEY")).toBe("k");
      const text = readFileSync(envFile(), "utf8");
      expect(text.match(/TM1_SECRETS/g)).toHaveLength(1);
    });

    it("refuses a multi-line value and changes nothing", async () => {
      const original =
        'TM1_BASE_URL=http://h:1\nTM1_ACCESS_TOKEN="line1\nline2"\n';
      writeEnv(original);
      expect(await run("migrate", "c")).toBe(1);
      expect(err.pop()).toMatch(/multi-line/);
      expect(readFileSync(envFile(), "utf8")).toBe(original);
      expect(store.entries.size).toBe(0);
    });

    // The file must not lose its only copy of the password.
    it("leaves the .env untouched when the keychain does not read back", async () => {
      const original = "TM1_BASE_URL=http://h:1\nTM1_PASSWORD=p\n";
      writeEnv(original);
      const lossy: SecretStore = {
        get: () => "",
        set: (_c: string, _k: SecretKey, _v: string) => {},
        delete: () => false,
      };
      expect(
        await runSecretsCli(
          ["migrate", "c"],
          { TM1_CONNECTIONS_DIR: root },
          io,
          lossy,
        ),
      ).toBe(1);
      expect(err.pop()).toMatch(/different value/);
      expect(readFileSync(envFile(), "utf8")).toBe(original);
    });
  });
});
