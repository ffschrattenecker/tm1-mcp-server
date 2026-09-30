import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type pino from "pino";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function makeConfig(): TM1Config {
  return {
    ...baseTestConfig,
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 5000,
    logLevel: "info",
  };
}

function mockResponse(body: unknown): Response {
  const bodyText = JSON.stringify(body);
  return {
    ok: true,
    status: 201,
    statusText: "Created",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – createNative()", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);

    const config = makeConfig();
    const sessionManager = new SessionManager(config, mockLogger);
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "authenticate").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sessionManager, "stopKeepAlive").mockImplementation(() => {});

    client = new TM1Client(config, sessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("getDefinition expands native axes in path form (11.8 rejects parenthesized options on complex collections)", async () => {
    // 1st request: base view (no MDX → native). 2nd request: tm1.NativeView expand.
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ Name: "NV", MDX: null }))
      .mockResolvedValueOnce(
        mockResponse({
          Titles: [
            {
              Subset: {
                Name: "",
                Expression: "{TM1SUBSETALL([Version])}",
                Hierarchy: { Name: "Version", Dimension: { Name: "Version" } },
              },
              Selected: { Name: "Actual" },
            },
          ],
          Columns: [
            {
              Subset: {
                Name: "All Months",
                Hierarchy: { Name: "Time", Dimension: { Name: "Time" } },
              },
            },
          ],
          Rows: [
            {
              Subset: {
                Name: "All Regions",
                Hierarchy: { Name: "Region", Dimension: { Name: "Region" } },
              },
            },
          ],
        }),
      );

    const def = await client.views.getDefinition("Sales", "NV", false);

    const nativeUrl = decodeURIComponent(String(fetchSpy.mock.calls[1][0]));
    // Path through the complex collection, parenthesized options only from the
    // entity (Subset) on — TM1 11.8 rejects Titles($expand=...) and pure path
    // form beyond the entity (live-verified).
    expect(nativeUrl).not.toContain("Titles($expand");
    expect(nativeUrl).not.toContain("Columns($expand");
    expect(nativeUrl).not.toContain("Rows($expand");
    expect(nativeUrl).toContain(
      "Titles/Subset($expand=Hierarchy($expand=Dimension))",
    );
    expect(nativeUrl).toContain("Titles/Selected");
    expect(nativeUrl).toContain(
      "Columns/Subset($expand=Hierarchy($expand=Dimension))",
    );
    expect(nativeUrl).toContain(
      "Rows/Subset($expand=Hierarchy($expand=Dimension))",
    );

    expect(def.type).toBe("Native");
    expect(def.native?.columns[0]).toEqual({
      dimensionName: "Time",
      hierarchyName: "Time",
      subsetName: "All Months",
      expression: undefined,
    });
    expect(def.native?.titles[0]).toEqual({
      dimensionName: "Version",
      hierarchyName: "Version",
      subsetName: undefined,
      expression: "{TM1SUBSETALL([Version])}",
      selectedElement: "Actual",
    });
  });
});
