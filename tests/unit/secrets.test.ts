import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  keychainAccount,
  keychainTarget,
  plaintextSecretKeys,
  usesKeychain,
  withKeychainSecrets,
  type SecretStore,
} from "../../src/secrets.js";
import { MemorySecretStore } from "../helpers/memory-secret-store.js";

const BASE = { TM1_BASE_URL: "http://tm1:8010", TM1_USER: "admin" };

describe("usesKeychain", () => {
  it("is false when TM1_SECRETS is unset or empty", () => {
    expect(usesKeychain({})).toBe(false);
    expect(usesKeychain({ TM1_SECRETS: "" })).toBe(false);
  });

  it("accepts keychain case-insensitively", () => {
    expect(usesKeychain({ TM1_SECRETS: " Keychain " })).toBe(true);
  });

  it("rejects an unknown store", () => {
    expect(() => usesKeychain({ TM1_SECRETS: "vault" })).toThrow(
      /Invalid TM1_SECRETS/,
    );
  });

  // Two sources for one password: which wins is not guessable, and a stale
  // one is a failed login that counts toward the lockout.
  it("rejects a keychain connection that still carries a plaintext secret", () => {
    expect(() =>
      usesKeychain({ TM1_SECRETS: "keychain", TM1_PASSWORD: "p" }),
    ).toThrow(/still sets TM1_PASSWORD/);
  });

  it("allows a blank password line next to the keychain marker", () => {
    expect(usesKeychain({ TM1_SECRETS: "keychain", TM1_PASSWORD: "" })).toBe(
      true,
    );
  });
});

describe("plaintextSecretKeys", () => {
  it("lists the non-empty secret keys only", () => {
    expect(
      plaintextSecretKeys({
        TM1_PASSWORD: "p",
        TM1_CLIENT_SECRET: "",
        TM1_API_KEY: "k",
        TM1_USER: "u",
      }),
    ).toEqual(["TM1_PASSWORD", "TM1_API_KEY"]);
  });
});

describe("keychain naming", () => {
  // tm1.py (stdlib only) reads the Windows entry by exactly this target.
  it("pins the account and Windows target name", () => {
    expect(keychainAccount("dev", "TM1_PASSWORD")).toBe("dev/TM1_PASSWORD");
    expect(keychainTarget("dev", "TM1_PASSWORD")).toBe(
      "dev/TM1_PASSWORD.tm1-mcp-server",
    );
  });
});

describe("withKeychainSecrets", () => {
  it("fills in the stored secrets and leaves the input untouched", async () => {
    const store = new MemorySecretStore();
    store.set("dev", "TM1_PASSWORD", "s3cret");
    const env = { ...BASE, TM1_SECRETS: "keychain" };

    const out = await withKeychainSecrets("dev", env, store);

    expect(out.TM1_PASSWORD).toBe("s3cret");
    expect(out.TM1_CLIENT_SECRET).toBeUndefined();
    expect(env).not.toHaveProperty("TM1_PASSWORD");
  });

  it("names the entry when the store throws", async () => {
    const store: SecretStore = {
      get: () => {
        throw new Error("access denied");
      },
      set: () => {},
      delete: () => false,
    };
    await expect(withKeychainSecrets("dev", BASE, store)).rejects.toThrow(
      /dev\/TM1_PASSWORD .*access denied/,
    );
  });
});

describe("loadConfig deferSecrets", () => {
  it("accepts a v11 connection without password or user", () => {
    const config = loadConfig(
      { TM1_BASE_URL: "http://tm1:8010" },
      { deferSecrets: true },
    );
    expect(config.baseUrl).toBe("http://tm1:8010");
    expect(config.password).toBe("");
  });

  it("still requires TM1_BASE_URL", () => {
    expect(() => loadConfig({ TM1_USER: "u" }, { deferSecrets: true })).toThrow(
      /TM1_BASE_URL/,
    );
  });

  it("accepts a v12 s2s connection without the client secret, not without the id", () => {
    const v12 = {
      ...BASE,
      TM1_INSTANCE: "i",
      TM1_DATABASE: "d",
      TM1_AUTH_MODE: "s2s",
    };
    expect(() => loadConfig(v12, { deferSecrets: true })).toThrow(
      /TM1_CLIENT_ID/,
    );
    expect(
      loadConfig({ ...v12, TM1_CLIENT_ID: "c" }, { deferSecrets: true })
        .version,
    ).toBe(12);
  });

  it("accepts v12 access_token and iam connections without their secret", () => {
    const v12 = { ...BASE, TM1_INSTANCE: "i", TM1_DATABASE: "d" };
    expect(
      loadConfig(
        { ...v12, TM1_AUTH_MODE: "access_token" },
        { deferSecrets: true },
      ).authMode,
    ).toBe("access_token");
    expect(
      loadConfig(
        { ...v12, TM1_AUTH_MODE: "iam", TM1_IAM_URL: "https://iam" },
        { deferSecrets: true },
      ).authMode,
    ).toBe("iam");
  });

  it("is strict without the option", () => {
    expect(() => loadConfig(BASE)).toThrow(/TM1_PASSWORD/);
  });
});
