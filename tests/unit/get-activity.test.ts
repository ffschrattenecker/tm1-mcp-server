import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import {
  captureParsedTool,
  mockResponse,
  stubbedClient,
} from "../helpers/client-harness.js";
import { parseIsoDurationSeconds } from "../../src/tm1-client/services/server-service.js";
import { registerGetActivity } from "../../src/tools/operations/get-activity.js";
import { ActivitySnapshotResultSchema } from "../../src/tools/schemas/items.js";

describe("parseIsoDurationSeconds", () => {
  it.each([
    ["P0DT00H01M04S", 64],
    ["P1DT02H00M00.5S", 93600.5],
    ["PT5S", 5],
    ["", undefined],
    ["not-a-duration", undefined],
  ])("%j -> %s", (input, expected) => {
    expect(parseIsoDurationSeconds(input)).toBe(expected);
  });
});

describe("ServerService.getActivitySnapshot() + tm1_get_activity", () => {
  let fetchSpy: FnSpy;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("v11 normalizes Threads + Sessions, filters idle by default, detects contention, and sorts waiters first", async () => {
    const client = stubbedClient(makeTestConfig({ version: 11 }));
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              ID: 1,
              Name: "Admin",
              Type: "User",
              State: "Idle",
              Function: "GET /Cubes",
              ElapsedTime: "P0DT00H00M00S",
              WaitTime: "P0DT00H00M00S",
              RLocks: 0,
              IXLocks: 0,
              WLocks: 0,
            },
            {
              ID: 2,
              Name: "Loader",
              Type: "User",
              State: "Run",
              Function: "POST /Processes('Nightly')/tm1.Execute",
              ObjectType: "Cube",
              ObjectName: "Sales",
              ElapsedTime: "P0DT00H02M00S",
              WaitTime: "P0DT00H00M00S",
              RLocks: 0,
              IXLocks: 1,
              WLocks: 2,
            },
            {
              ID: 3,
              Name: "Analyst",
              Type: "User",
              State: "Wait",
              Function: "POST /ExecuteMDX",
              ObjectType: "Cube",
              ObjectName: "Sales",
              ElapsedTime: "P0DT00H00M30S",
              WaitTime: "P0DT00H00M25S",
              RLocks: 1,
              IXLocks: 0,
              WLocks: 0,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              ID: 10,
              Active: true,
              Context: "MCP",
              User: { Name: "Admin", FriendlyName: "Administrator" },
            },
          ],
        }),
      );

    const call = captureParsedTool(registerGetActivity, client);
    const res = (await call({})) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0].text);

    expect(() => ActivitySnapshotResultSchema.parse(payload)).not.toThrow();
    expect(payload.version).toBe(11);
    expect(payload.source).toBe("Threads");
    expect(payload.summary).toMatchObject({
      totalActivities: 3,
      activeCount: 2,
      waitingCount: 1,
      idleOmitted: 1,
      sessionCount: 1,
      hasContention: true,
      lockHolders: ["2"],
      waiters: ["3"],
      longestElapsedSeconds: 120,
      longestWaitSeconds: 25,
    });
    expect(payload.activities.map((a: { id: string }) => a.id)).toEqual([
      "3",
      "2",
    ]);
    expect(payload.warnings[0]).toContain("Threads(id)/tm1.CancelOperation");
  });

  it("v12 (including split-brain tm1Version '11.8') queries Jobs and falls back if $expand fails", async () => {
    const client = stubbedClient(
      makeTestConfig({ version: 12, tm1Version: "11.8" }),
    );
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: new Headers(),
        text: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({ error: { message: "expand unsupported" } }),
          ),
        json: vi
          .fn()
          .mockResolvedValue({ error: { message: "expand unsupported" } }),
      })
      .mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              ID: "job-99",
              Description: "POST /ExecuteMDX",
              State: "Waiting",
              ElapsedTime: "P0DT00H00M45S",
              WaitTime: "P0DT00H00M10S",
              WaitingOn: ["job-11"],
            },
          ],
        }),
      );

    const snap = await client.server.getActivitySnapshot({
      includeSessions: false,
    });
    expect(snap.version).toBe(12);
    expect(snap.source).toBe("Jobs");
    expect(snap.activities[0]).toMatchObject({
      id: "job-99",
      kind: "job",
      state: "Waiting",
      waitingOn: ["job-11"],
      elapsedSeconds: 45,
      waitSeconds: 10,
    });
  });

  it("handles partial failure when Sessions endpoint rejects", async () => {
    const client = {
      server: {
        getActivitySnapshot: vi.fn().mockResolvedValue({
          version: 11,
          source: "Threads",
          activities: [],
          sessionsError: "ObjectSecurityNoReadRights",
        }),
      },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerGetActivity, client);
    const res = (await call({ format: "markdown" })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0].text).toContain("Sessions query failed");
  });
});
