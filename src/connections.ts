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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import type pino from "pino";
import { loadConfig, type TM1Config } from "./config.js";
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

export interface ConnectionInfo {
  name: string;
  /** Folder the `.env` came from; undefined for the legacy single connection. */
  dir?: string | undefined;
  mode?: TM1Config["mode"] | undefined;
  version?: 11 | 12 | undefined;
  tm1Version?: string | undefined;
  baseUrl?: string | undefined;
  /** Set when the folder's `.env` could not be turned into a config. */
  configError?: string | undefined;
}

interface Entry {
  info: ConnectionInfo;
  config?: TM1Config;
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

  private constructor(private readonly logger: pino.Logger) {}

  /** Discover connections from the environment (see the header comment). */
  static fromEnvironment(
    env: NodeJS.ProcessEnv,
    logger: pino.Logger,
  ): ConnectionRegistry {
    const registry = new ConnectionRegistry(logger);
    const explicitDir = env.TM1_CONNECTIONS_DIR;
    if (!explicitDir && env.TM1_BASE_URL) {
      registry.addConfig("default", loadConfig(env));
      return registry;
    }
    const dir = explicitDir || join(homedir(), ".tm1", "mcp-servers");
    registry.discover(dir, env);
    if (registry.entries.size === 0) {
      throw new Error(
        `No TM1 connections found. Set TM1_BASE_URL (single connection) or ` +
          `create <name>/.env folders under ${dir} (or point TM1_CONNECTIONS_DIR at them).`,
      );
    }
    return registry;
  }

  /** Wrap one prebuilt client (tests, embedders). */
  static single(
    client: TM1Client,
    logger: pino.Logger,
    info: Partial<ConnectionInfo> = {},
  ): ConnectionRegistry {
    const registry = new ConnectionRegistry(logger);
    registry.entries.set("default", {
      info: {
        name: "default",
        version: client.version,
        mode: "readwrite",
        ...info,
      },
      client,
    });
    return registry;
  }

  private addConfig(name: string, config: TM1Config, dir?: string): void {
    this.entries.set(name, {
      info: {
        name,
        dir,
        mode: config.mode,
        version: config.version,
        tm1Version: config.tm1Version,
        baseUrl: config.baseUrl,
      },
      config,
    });
  }

  private discover(dir: string, env: NodeJS.ProcessEnv): void {
    if (!existsSync(dir)) return;
    const only = env.TM1_CONNECTIONS
      ? new Set(
          env.TM1_CONNECTIONS.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : undefined;

    // Server-level settings and non-TM1 variables (PATH, proxies) carry over;
    // connection-level TM1_* keys come from the folder only.
    const base: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith("TM1_") || isServerLevelKey(key)) base[key] = value;
    }

    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, ".env")))
      .map((d) => d.name)
      .filter((name) => !only || only.has(name))
      .sort((a, b) => a.localeCompare(b));

    for (const name of names) {
      const folder = join(dir, name);
      try {
        const fileEnv = parseDotenv(readFileSync(join(folder, ".env")));
        const connEnv: NodeJS.ProcessEnv = { ...base };
        for (const [key, value] of Object.entries(fileEnv)) {
          // The folder may not override server-level settings: one folder's
          // TM1_MCP_TRANSPORT must not reconfigure the whole process.
          if (!isServerLevelKey(key)) connEnv[key] = value;
        }
        this.addConfig(name, loadConfig(connEnv), folder);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          { connection: name, err: message },
          "skipping connection",
        );
        this.entries.set(name, {
          info: { name, dir: folder, configError: message },
        });
      }
    }
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
    return this.entries.size === 1;
  }

  get anyReadwrite(): boolean {
    return [...this.entries.values()].some((e) => e.info.mode === "readwrite");
  }

  hasVersion(version: 11 | 12): boolean {
    return [...this.entries.values()].some((e) => e.info.version === version);
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
      if (this.isSingle) return [...this.entries.values()][0]!;
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `connection is required. One of: ${this.names.join(", ")}.`,
      });
    }
    const entry = this.entries.get(name);
    if (!entry) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Unknown connection "${name}". One of: ${this.names.join(", ")}.`,
      });
    }
    if (entry.info.configError) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Connection "${name}" is misconfigured: ${entry.info.configError}`,
      });
    }
    return entry;
  }

  /**
   * The client for a connection, built and logged in on first use. A failed
   * login does not poison the entry: the client's own request path retries
   * authentication, so the next call gets a fresh attempt.
   */
  async get(name: string | undefined): Promise<TM1Client> {
    const entry = this.entryFor(name);
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
