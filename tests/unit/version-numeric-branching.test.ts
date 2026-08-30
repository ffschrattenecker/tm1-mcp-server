import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnectionProfile } from "../../src/tm1-client/connection/profile.js";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type pino from "pino";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1ErrorCode } from "../../src/types.js";
import type { TM1Config } from "../../src/config.js";

// A3 regression: service version-gating must branch on the NUMERIC
// config.version (single source of truth), never on the tm1Version display
// string. The decisive case is the split-brain: version === 12 while the
// display string still reads "11.8" — the numeric must win.

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

function makeConfig(over: Partial<TM1Config>): TM1Config {
  return {
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 5000,
    logLevel: "info",
    version: 11,
    tm1Version: "11.8",
    instance: "inst",
    database: "db",
    ...over,
  } as unknown as TM1Config;
}

function makeClient(config: TM1Config): TM1Client {
  const sessionManager = new SessionManager(config, mockLogger);
  vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
  vi.spyOn(sessionManager, "authenticate").mockResolvedValue("session123");
  return new TM1Client(config, sessionManager, mockLogger);
}

describe("A3 — service version-gating uses numeric config.version", () => {
  let fetchSpy: FnSpy;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("partial clear throws UNSUPPORTED_OPERATION on both versions", async () => {
    // tm1.Clear resolves on neither 11.8 nor 12.5, so this is not a version
    // branch any more — it must refuse before touching the network either way.
    for (const version of [11, 12] as const) {
      fetchSpy.mockClear();
      const client = makeClient(makeConfig({ version, tm1Version: "11.8" }));
      await expect(
        client.cubes.clear("Sales", ["Region", "Month"], [["North"], []]),
      ).rejects.toMatchObject({ code: TM1ErrorCode.UNSUPPORTED_OPERATION });
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("split-brain (version 12 but string '11.8'): connection profile takes the v12 reroot", () => {
    // If a branch keyed off the STRING, "11.8" would pick the v11 profile,
    // whose resolveApiPath is the identity. Keyed off numeric version===12 it
    // must reroot the /api/v1 prefix onto the instance/database path instead.
    const v12 = createConnectionProfile(
      makeConfig({ version: 12, tm1Version: "11.8" }),
    );
    expect(v12.resolveApiPath("/api/v1/Cubes")).not.toBe("/api/v1/Cubes");

    const v11 = createConnectionProfile(
      makeConfig({ version: 11, tm1Version: "11.8" }),
    );
    expect(v11.resolveApiPath("/api/v1/Cubes")).toBe("/api/v1/Cubes");
  });

  it("exposes numeric version off the held HTTP client via the same source of truth", () => {
    // TM1Client.version and the http-client branch source agree (both config.version).
    expect(
      makeClient(makeConfig({ version: 12, tm1Version: "11.8" })).version,
    ).toBe(12);
    expect(
      makeClient(makeConfig({ version: 11, tm1Version: "11.8" })).version,
    ).toBe(11);
  });
});
