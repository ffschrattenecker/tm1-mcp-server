// Connection secrets kept in the OS keychain instead of the `.env`.
//
// A connection folder opts in with `TM1_SECRETS=keychain`. Its `.env` then
// carries no secret; each one lives in the OS store (Windows Credential
// Manager, macOS Keychain, Linux Secret Service) under
//
//   service "tm1-mcp-server", account "<connection>/<KEY>"
//   Windows target name "<connection>/<KEY>.tm1-mcp-server"
//
// The Windows target name is the library default ("<account>.<service>"),
// and must stay that way because a stdlib-only reader — the tm1-api
// skill's tm1.py calls CredReadW via ctypes — looks the entry up by it. The
// blob is UTF-16LE. Entry.withTarget() is deliberately not used: in
// @napi-rs/keyring 2.1.0 on Windows a fresh Entry reads back "" for it.
//
// Discovery never reads the store: loadConfig(env, { deferSecrets: true })
// accepts the folder, and the secrets are read when the connection is first
// used (ConnectionRegistry.get). Listing connections therefore never touches
// the keychain, and a missing entry fails that one connection, not startup.
//
// What this protects: the secret no longer sits in a file that gets synced,
// backed up, committed, pasted or read into an agent's context. What it does
// not: any process running as the same OS user can read the store too.
import { TM1Error, TM1ErrorCode } from "./types.js";

/** Every `.env` key that holds a credential. */
export const SECRET_KEYS = [
  "TM1_PASSWORD",
  "TM1_CLIENT_SECRET",
  "TM1_ACCESS_TOKEN",
  "TM1_API_KEY",
  "TM1_CAM_PASSPORT",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export const KEYCHAIN_SERVICE = "tm1-mcp-server";

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

export function keychainAccount(connection: string, key: SecretKey): string {
  return `${connection}/${key}`;
}

/** Secret keys that carry a non-empty plaintext value in `env`. */
export function plaintextSecretKeys(env: NodeJS.ProcessEnv): SecretKey[] {
  return SECRET_KEYS.filter((key) => Boolean(env[key]));
}

/**
 * True when the connection keeps its secrets in the keychain. Throws on an
 * unknown TM1_SECRETS value, and when a keychain connection still carries a
 * plaintext secret — which of the two should win is not guessable, and a
 * stale one is exactly the kind of wrong password that locks an account.
 * An empty value (`TM1_PASSWORD=`, a blank-password account) is no conflict.
 */
export function usesKeychain(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TM1_SECRETS?.trim().toLowerCase();
  if (!raw) return false;
  if (raw !== "keychain") {
    throw new Error(
      `Invalid TM1_SECRETS: "${env.TM1_SECRETS}". Expected "keychain" or unset.`,
    );
  }
  const plain = plaintextSecretKeys(env);
  if (plain.length > 0) {
    throw new Error(
      `TM1_SECRETS=keychain, but the .env still sets ${plain.join(", ")}. ` +
        `Remove ${plain.length === 1 ? "it" : "them"} from the .env ` +
        `(\`tm1-mcp-server secrets migrate <connection>\` does both steps).`,
    );
  }
  return true;
}

/** The OS store, narrowed to what the server and the CLI need. */
export interface SecretStore {
  get(connection: string, key: SecretKey): string | undefined;
  set(connection: string, key: SecretKey, value: string): void;
  /** True when an entry existed. */
  delete(connection: string, key: SecretKey): boolean;
}

let osStore: Promise<SecretStore> | undefined;

/**
 * The OS keychain. The native binding is imported on first use, so a
 * platform without a prebuilt binary only breaks connections that ask for it.
 */
export function keychainStore(): Promise<SecretStore> {
  osStore ??= import("@napi-rs/keyring").then(
    ({ Entry }): SecretStore => {
      const entry = (connection: string, key: SecretKey) =>
        new Entry(KEYCHAIN_SERVICE, keychainAccount(connection, key));
      return {
        get: (connection, key) =>
          entry(connection, key).getPassword() ?? undefined,
        set: (connection, key, value) =>
          entry(connection, key).setPassword(value),
        delete: (connection, key) => entry(connection, key).deletePassword(),
      };
    },
    (err: unknown) => {
      osStore = undefined;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The OS keychain is not available on this platform (${reason}).`,
      );
    },
  );
  return osStore;
}

/**
 * `env` with every secret the keychain holds for `connection` filled in. The
 * result goes straight into loadConfig and is never written to process.env,
 * so child processes do not inherit it.
 */
export async function withKeychainSecrets(
  connection: string,
  env: NodeJS.ProcessEnv,
  store?: SecretStore,
): Promise<NodeJS.ProcessEnv> {
  let resolved: SecretStore;
  try {
    resolved = store ?? (await keychainStore());
  } catch (err) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Connection "${connection}" keeps its secrets in the OS keychain: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SECRET_KEYS) {
    let value: string | undefined;
    try {
      value = resolved.get(connection, key);
    } catch (err) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Reading ${keychainAccount(connection, key)} from the OS keychain failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Appended to a config error on a keychain connection: how to fix it. */
export function keychainHint(connection: string): string {
  return (
    ` The secrets of "${connection}" are read from the OS keychain; store the ` +
    `missing one with \`npx -y @ffschrattenecker/tm1-mcp-server secrets set ${connection} <KEY>\`.`
  );
}
