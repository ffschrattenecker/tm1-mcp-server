// Named TM1 connections served by ONE server process.
//
// Before v7 every TM1 connection was its own server: one `.env` per folder
// under ~/.tm1/mcp-servers/, one process, one full copy of the tool list. With
// N connections a client carried N × ~113 tool names in context every turn,
// spawned N processes and held N sessions + keepalives open. The registry keeps
// the same folders as the source of truth (they are also what the tm1-api
// skill reads) but serves them all from one tool list: every tool takes a
// `connection` argument, and each connection's TM1Client is built on first use.
//
// Selection:
//   TM1_CONNECTIONS_DIR set          → discover that folder
//   TM1_BASE_URL set (and no dir)    → legacy single connection "default"
//   neither                          → discover ~/.tm1/mcp-servers
// TM1_CONNECTIONS (comma-separated) narrows discovery to the named folders.
//
// Per connection, only the folder's own `.env` decides mode and version. Mode
// defaults to readonly: a connection-level key (TM1_MODE, TM1_BASE_URL, …) in
// the server's own environment is NOT inherited, so a TM1_MODE=readwrite in
// the launching shell cannot silently arm every connection.
//
// A folder with TM1_SECRETS=keychain keeps its secrets in the OS keychain
// (see ./secrets.ts). Discovery validates it without them; get() reads them
// and builds the real config on first use.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import pino from "pino";
import { connectionIdOf, loadConfig, type TM1Config } from "./config.js";
import {
  keychainHint,
  plaintextSecretKeys,
  SECRET_KEYS,
  usesKeychain,
  withKeychainSecrets,
  type SecretStore,
} from "./secrets.js";
import { SessionManager } from "./session-manager.js";
import { TM1Client } from "./tm1-client.js";
import { TM1Error, TM1ErrorCode } from "./types.js";

/** Settings that belong to the server process, not to one TM1 connection. */
const SERVER_LEVEL_KEYS = new Set([
  "TM1_LOG_LEVEL",
  "TM1_LOG_FILE",
  "TM1_RESPONSE_MODE",
  "TM1_MAX_RESPONSE_CHARS",
  "TM1_CONNECTIONS_DIR",
  "TM1_CONNECTIONS",
]);

function isServerLevelKey(key: string): boolean {
  return SERVER_LEVEL_KEYS.has(key) || key.startsWith("TM1_MCP_");
}

/** Folder holding one `<name>/.env` per connection. */
export function connectionsDir(env: NodeJS.ProcessEnv): string {
  return env.TM1_CONNECTIONS_DIR || join(homedir(), ".tm1", "mcp-servers");
}

/**
 * The environment one connection folder resolves to — the only way a
 * connection's `.env` is read, by the server and by scripts/run-live-for.ts
 * alike, so a script can never log in with a differently parsed password.
 *
 * Server-level settings and non-TM1 variables (PATH, proxies) carry over from
 * `env`; connection-level TM1_* keys come from the folder only, so a stray
 * TM1_INSTANCE in the shell cannot reroute a v11 connection. The folder may
 * not override server-level settings: one folder's TM1_MCP_TRANSPORT must not
 * reconfigure the whole process.
 */
export function connectionEnv(
  folder: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const connEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("TM1_") || isServerLevelKey(key)) connEnv[key] = value;
  }
  const fileEnv = parseDotenv(readFileSync(join(folder, ".env")));
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!isServerLevelKey(key)) connEnv[key] = value;
  }
  return connEnv;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Hash of every secret in `env`; compares credentials without keeping them. */
function secretHashOf(env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha256");
  for (const key of SECRET_KEYS)
    hash.update(JSON.stringify([key, env[key] ?? ""]));
  return hash.digest("hex");
}

export interface ConnectionInfo {
  name: string;
  /** Folder the `.env` came from; undefined for the legacy single connection. */
  dir?: string | undefined;
  mode?: TM1Config["mode"] | undefined;
  environment?: TM1Config["environment"];
  /** Why mode differs from TM1_MODE (prod forces readonly). */
  modeReason?: string | undefined;
  version?: 11 | 12 | undefined;
  tm1Version?: string | undefined;
  baseUrl?: string | undefined;
  /** connectionIdOf() — what mutation events and caches are keyed by. */
  connectionId?: string | undefined;
  /** Set when the folder's `.env` could not be turned into a config. */
  configError?: string | undefined;
  /** "keychain" when the secrets are read from the OS keychain on first use. */
  secrets?: "keychain" | undefined;
}

interface Entry {
  info: ConnectionInfo;
  config?: TM1Config;
  /** Keychain connections: the env to fill with secrets on first use. */
  env?: NodeJS.ProcessEnv;
  resolving?: Promise<TM1Config> | undefined;
  /** mtime of the folder's `.env` when it was loaded (rescan change check). */
  envMtime?: number | undefined;
  /** Hash of the keychain secrets the current config was built from. */
  secretHash?: string | undefined;
  client?: TM1Client;
  connecting?: Promise<void> | undefined;
  lastError?: string | undefined;
}

export interface ConnectionStatus extends ConnectionInfo {
  connected: boolean;
  lastError?: string | undefined;
}

export class ConnectionRegistry {
  private readonly entries = new Map<string, Entry>();
  /** Folder (and process env) discovery runs against; unset for single/of(). */
  private discoveryDir: string | undefined;
  private discoveryEnv: NodeJS.ProcessEnv = {};

  private constructor(
    private readonly logger: pino.Logger,
    /** Defaults to the OS keychain; tests inject a fake. */
    private readonly secretStore?: SecretStore,
  ) {}

  /** Discover connections from the environment (see the header comment). */
  static fromEnvironment(
    env: NodeJS.ProcessEnv,
    logger: pino.Logger,
    options: { secretStore?: SecretStore } = {},
  ): ConnectionRegistry {
    const registry = new ConnectionRegistry(logger, options.secretStore);
    const explicitDir = env.TM1_CONNECTIONS_DIR;
    if (!explicitDir && env.TM1_BASE_URL) {
      registry.addEnv("default", env);
      return registry;
    }
    const dir = connectionsDir(env);
    registry.discoveryDir = dir;
    registry.discoveryEnv = env;
    registry.discover(dir, env);
    // No folder at all is a valid state: the server starts with an empty
    // registry so a first connection can be added without a restart (see
    // refresh()). Folders that exist but none is usable still fail at
    // startup with every reason, rather than serve a broken `connection` enum.
    if (registry.entries.size > 0 && registry.usableNames.length === 0) {
      const reasons = registry
        .status()
        .map((c) => `  ${c.name}: ${c.configError}`)
        .join("\n");
      throw new Error(`No usable TM1 connection under ${dir}:\n${reasons}`);
    }
    return registry;
  }

  /** Wrap one prebuilt client (tests, embedders). */
  static single(
    client: TM1Client,
    logger: pino.Logger = pino({ level: "silent" }),
  ): ConnectionRegistry {
    return ConnectionRegistry.of([{ name: "default", client }], logger);
  }

  /**
   * Prebuilt clients under explicit names. The owner keeps the clients'
   * lifecycle: disconnectAll() leaves them alone. Mode defaults to readwrite
   * because the registration-time gate (TM1_MODE via withAnnotations) already
   * decided what an embedder may call.
   */
  static of(
    clients: ReadonlyArray<{
      name: string;
      client: TM1Client;
      mode?: TM1Config["mode"];
    }>,
    logger: pino.Logger = pino({ level: "silent" }),
  ): ConnectionRegistry {
    const registry = new ConnectionRegistry(logger);
    for (const { name, client, mode } of clients) {
      registry.entries.set(name, {
        info: {
          name,
          version: client.version,
          mode: mode ?? "readwrite",
          connectionId: client.connectionId,
        },
        client,
      });
    }
    return registry;
  }

  /** Validate one connection's env; keychain secrets are read later. */
  private addEnv(name: string, env: NodeJS.ProcessEnv, dir?: string): void {
    const keychain = usesKeychain(env);
    const config = loadConfig(env, { deferSecrets: keychain });
    this.addConfig(name, config, dir);
    if (keychain) {
      const entry = this.entries.get(name)!;
      entry.env = env;
      entry.info.secrets = "keychain";
    }
  }

  private addConfig(name: string, config: TM1Config, dir?: string): void {
    this.entries.set(name, {
      info: {
        name,
        dir,
        mode: config.mode,
        environment: config.environment,
        modeReason: config.modeReason,
        version: config.version,
        tm1Version: config.tm1Version,
        baseUrl: config.baseUrl,
        connectionId: connectionIdOf(config),
      },
      config,
    });
  }

  /** Folder names under `dir` holding a `.env`, honouring TM1_CONNECTIONS. */
  private scan(dir: string, env: NodeJS.ProcessEnv): string[] {
    if (!existsSync(dir)) return [];
    const only = env.TM1_CONNECTIONS
      ? new Set(
          env.TM1_CONNECTIONS.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : undefined;
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, ".env")))
      .map((d) => d.name)
      .filter((name) => !only || only.has(name))
      .sort((a, b) => a.localeCompare(b));
  }

  /** Load one folder into the registry; true when it holds a plaintext secret. */
  private loadFolder(
    name: string,
    folder: string,
    env: NodeJS.ProcessEnv,
  ): boolean {
    const envMtime = mtimeOf(join(folder, ".env"));
    try {
      const connEnv = connectionEnv(folder, env);
      this.addEnv(name, connEnv, folder);
      const entry = this.entries.get(name)!;
      entry.envMtime = envMtime;
      return !entry.env && plaintextSecretKeys(connEnv).length > 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { connection: name, err: message },
        "skipping connection",
      );
      this.entries.set(name, {
        info: { name, dir: folder, configError: message },
        envMtime,
      });
      return false;
    }
  }

  private warnPlaintext(plaintext: string[]): void {
    if (plaintext.length === 0) return;
    this.logger.warn(
      { connections: plaintext },
      "plaintext secrets in .env — move them to the OS keychain with " +
        "`npx -y @ffschrattenecker/tm1-mcp-server secrets migrate <connection>`",
    );
  }

  private discover(dir: string, env: NodeJS.ProcessEnv): void {
    this.warnPlaintext(
      this.scan(dir, env).filter((name) =>
        this.loadFolder(name, join(dir, name), env),
      ),
    );
  }

  /**
   * Re-run discovery so connections added, removed or edited after startup
   * show up without restarting the server. There is no file watcher: it runs
   * from tm1_list_connections and before an "Unknown connection" error.
   *
   * - a new folder is added, a removed folder is dropped;
   * - a folder whose `.env` mtime changed is reloaded, but only when its
   *   connection has no live session (never connected, logged out, or latched
   *   on a rejected login). A connected one keeps the credentials it logged
   *   in with until its session ends.
   *
   * No-op for the legacy single connection and prebuilt clients.
   */
  refresh(): void {
    const dir = this.discoveryDir;
    if (dir === undefined) return;
    const found = this.scan(dir, this.discoveryEnv);
    const foundSet = new Set(found);
    for (const [name, entry] of [...this.entries]) {
      if (entry.info.dir !== undefined && !foundSet.has(name)) {
        this.entries.delete(name);
        this.dispose(entry);
        this.logger.info({ connection: name }, "connection folder removed");
      }
    }
    const plaintext: string[] = [];
    for (const name of found) {
      const folder = join(dir, name);
      const existing = this.entries.get(name);
      if (existing) {
        if (mtimeOf(join(folder, ".env")) === existing.envMtime) continue;
        if (this.hasLiveSession(existing)) continue;
        this.entries.delete(name);
        this.dispose(existing);
      }
      if (this.loadFolder(name, folder, this.discoveryEnv)) {
        plaintext.push(name);
      }
      this.logger.info({ connection: name }, "connection folder (re)loaded");
    }
    this.warnPlaintext(plaintext);
    // Keep the name-sorted order discovery gave, whatever was added or replaced.
    const sorted = [...this.entries].sort(([a], [b]) => a.localeCompare(b));
    this.entries.clear();
    for (const [name, entry] of sorted) this.entries.set(name, entry);
  }

  /** A login is in flight or a session is open; a latched one is neither. */
  private hasLiveSession(entry: Entry): boolean {
    return (
      entry.connecting !== undefined ||
      entry.resolving !== undefined ||
      (entry.client?.sessionActive ?? false)
    );
  }

  /** Release a replaced or removed entry's client; failures are only logged. */
  private dispose(entry: Entry): void {
    const client = entry.client;
    if (!client || !entry.config) return; // prebuilt clients are the owner's
    client.disconnect().catch((err: unknown) => {
      this.logger.error(
        { err, connection: entry.info.name },
        "disconnect failed",
      );
    });
  }

  /** Folder discovery runs against; undefined in single-connection mode. */
  get dir(): string | undefined {
    return this.discoveryDir;
  }

  /** Every connection name, including ones whose config failed to load. */
  get names(): string[] {
    return [...this.entries.keys()];
  }

  /** Connections that can actually be used. */
  get usableNames(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.config || e.client)
      .map((e) => e.info.name);
  }

  /** True when tools should not expose a `connection` argument at all. */
  get isSingle(): boolean {
    return this.usableNames.length === 1;
  }

  get anyReadwrite(): boolean {
    return [...this.entries.values()].some((e) => e.info.mode === "readwrite");
  }

  hasVersion(version: 11 | 12): boolean {
    return [...this.entries.values()].some((e) => e.info.version === version);
  }

  /** A client exists and is not mid-login. Never triggers a login itself. */
  isConnected(name: string): boolean {
    const entry = this.entries.get(name);
    return entry?.client !== undefined && entry.connecting === undefined;
  }

  info(name: string): ConnectionInfo | undefined {
    return this.entries.get(name)?.info;
  }

  status(): ConnectionStatus[] {
    return [...this.entries.values()].map((e) => ({
      ...e.info,
      connected:
        e.client !== undefined && e.connecting === undefined && !e.lastError,
      lastError: e.lastError,
    }));
  }

  /** Resolve a connection name (optional when there is only one). */
  private entryFor(name: string | undefined): Entry {
    if (name === undefined) {
      if (this.usableNames.length === 0) this.refresh();
      if (this.isSingle) return this.entries.get(this.usableNames[0]!)!;
      throw (
        this.noConnections() ??
        new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `connection is required. One of: ${this.names.join(", ")}.`,
        })
      );
    }
    let entry = this.entries.get(name);
    if (!entry) {
      // The folder may have been created after startup.
      this.refresh();
      entry = this.entries.get(name);
    }
    if (!entry) {
      throw (
        this.noConnections() ??
        new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Unknown connection "${name}". One of: ${this.names.join(", ")}.`,
        })
      );
    }
    if (entry.info.configError) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Connection "${name}" is misconfigured: ${entry.info.configError}`,
      });
    }
    return entry;
  }

  /** Set when no connection exists at all: where to create one. */
  private noConnections(): TM1Error | undefined {
    if (this.entries.size > 0) return undefined;
    return new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `No TM1 connection configured under ${this.discoveryDir ?? "(none)"}`,
      hint: "Create <name>/.env there (TM1_BASE_URL, TM1_USER, TM1_SECRETS=keychain; PA SaaS: TM1_AUTH_MODE=saas, TM1_TENANT), then `secrets set <name>`. No restart needed.",
    });
  }

  /** The folder's current credential inputs: `.env` mtime + secret hash. */
  private async credentialFingerprint(entry: Entry): Promise<string> {
    const dir = entry.info.dir!;
    const mtime = mtimeOf(join(dir, ".env"));
    const secrets = entry.env
      ? secretHashOf(
          await withKeychainSecrets(
            entry.info.name,
            { TM1_SECRETS: "keychain" },
            this.secretStore,
          ),
        )
      : "";
    return `${mtime}:${secrets}`;
  }

  /**
   * True when the credential inputs differ from those the latched client
   * logged in with. An unreadable keychain counts as unchanged: the latch
   * stays, so a failing lookup can never turn into extra login attempts.
   */
  private async credentialsChanged(entry: Entry): Promise<boolean> {
    try {
      const now = await this.credentialFingerprint(entry);
      return now !== `${entry.envMtime}:${entry.secretHash ?? ""}`;
    } catch {
      return false;
    }
  }

  /**
   * The client for a connection, built and logged in on first use. A failed
   * login does not poison the entry: the client's own request path retries
   * authentication, so the next call gets a fresh attempt — except when TM1
   * rejected the credentials (401/403). The client is kept, so its
   * SessionManager's latch answers every later call without another login
   * until the credential inputs (`.env` mtime, keychain secret) change; then
   * the connection is reloaded and gets exactly one new attempt.
   */
  async get(name: string | undefined): Promise<TM1Client> {
    let entry = this.entryFor(name);
    if (
      entry.client?.loginRejected &&
      entry.info.dir !== undefined &&
      (await this.credentialsChanged(entry))
    ) {
      this.logger.info(
        { connection: entry.info.name },
        "credentials changed after a rejected login; reloading connection",
      );
      this.entries.delete(entry.info.name);
      this.dispose(entry);
      this.loadFolder(entry.info.name, entry.info.dir, this.discoveryEnv);
      entry = this.entryFor(entry.info.name);
    }
    if (!entry.client && entry.env) {
      // Concurrent first calls share one keychain read. A failure is not
      // cached: the next call reads again, after the user stored the entry.
      entry.resolving ??= this.resolveSecrets(entry)
        .catch((err: unknown) => {
          entry.lastError = err instanceof Error ? err.message : String(err);
          throw err;
        })
        .finally(() => {
          entry.resolving = undefined;
        });
      entry.config = await entry.resolving;
    }
    if (!entry.client) {
      const config = entry.config!;
      const logger = this.logger.child({ connection: entry.info.name });
      const sessionManager = new SessionManager(config, logger);
      entry.client = new TM1Client(config, sessionManager, logger);
      entry.connecting = entry.client
        .connect()
        .then(() => {
          entry.lastError = undefined;
        })
        .catch((err: unknown) => {
          entry.lastError = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err },
            "initial TM1 connection failed — will retry on request",
          );
        })
        .finally(() => {
          entry.connecting = undefined;
        });
    }
    if (entry.connecting) await entry.connecting;
    return entry.client;
  }

  /** The full config of a keychain connection, secrets included. */
  private async resolveSecrets(entry: Entry): Promise<TM1Config> {
    const { name } = entry.info;
    const env = await withKeychainSecrets(name, entry.env!, this.secretStore);
    entry.secretHash = secretHashOf(env);
    try {
      return loadConfig(env);
    } catch (err) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Connection "${name}": ${
          err instanceof Error ? err.message : String(err)
        }${keychainHint(name)}`,
      });
    }
  }

  /** Connection metadata for a resolved call (mode/version gates). */
  resolveInfo(name: string | undefined): ConnectionInfo {
    return this.entryFor(name).info;
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (e) => {
        if (!e.client || !e.config) return; // prebuilt clients are the owner's
        try {
          await e.client.disconnect();
        } catch (err) {
          this.logger.error(
            { err, connection: e.info.name },
            "disconnect failed",
          );
        }
      }),
    );
  }
}
