import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import {
  captureParsedTool,
  mockResponse,
  stubbedClient,
} from "../helpers/client-harness.js";
import { registerQueryLogs } from "../../src/tools/operations/query-logs.js";
import { QueryLogsResultSchema } from "../../src/tools/schemas/items.js";

describe("tm1_query_logs", () => {
  let fetchSpy: FnSpy;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("v12 (including split-brain tm1Version '11.8') returns unsupported_v12 with zero HTTP calls", async () => {
    const client = stubbedClient(
      makeTestConfig({ version: 12, tm1Version: "11.8" }),
    );
    const call = captureParsedTool(registerQueryLogs, client);
    const res = (await call({ logType: "transaction" })) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(res.content[0].text);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => QueryLogsResultSchema.parse(payload)).not.toThrow();
    expect(payload.unavailable).toMatchObject({ reason: "unsupported_v12" });
    expect(payload.items).toEqual([]);
  });

  it("request shape: v11 TransactionLogEntries with cubeName, user, element, OData quote escaping, and paging", async () => {
    const client = stubbedClient(makeTestConfig({ version: 11 }));
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        "@odata.count": 12,
        value: [
          {
            ID: 1001,
            ChangeSetID: "0",
            TimeStamp: "2026-11-27T10:00:00Z",
            User: "O'Brien",
            Cube: "Sales",
            Tuple: ["2026", "Jan", "Actual"],
            OldValue: 10,
            NewValue: 20,
          },
        ],
      }),
    );

    const call = captureParsedTool(registerQueryLogs, client);
    const res = (await call({
      logType: "transaction",
      since: "2026-11-27T00:00:00Z",
      until: "2026-11-27T23:59:59Z",
      cubeName: "Sales",
      user: "O'Brien",
      element: "Jan",
      limit: 5,
      offset: 0,
      order: "desc",
    })) as { content: Array<{ text: string }> };

    const url = decodeURIComponent(String(fetchSpy.mock.calls[0][0]));
    expect(url).toContain("/api/v1/TransactionLogEntries?");
    expect(url).toContain("TimeStamp ge 2026-11-27T00:00:00Z");
    expect(url).toContain("TimeStamp le 2026-11-27T23:59:59Z");
    expect(url).toContain("Cube eq 'Sales'");
    expect(url).toContain("User eq 'O''Brien'");
    expect(url).toContain("Tuple/any(t: t eq 'Jan')");
    expect(url).toContain("$orderby=TimeStamp desc");
    expect(url).toContain("$top=5");
    expect(url).toContain("$count=true");

    const payload = JSON.parse(res.content[0].text);
    expect(() => QueryLogsResultSchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      logType: "transaction",
      version: 11,
      total: 12,
      count: 1,
      has_more: true,
      next_offset: 1,
    });
  });

  it("request shape: v11 MessageLogEntries masks secrets in Message", async () => {
    const client = stubbedClient(makeTestConfig({ version: 11 }));
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        "@odata.count": 1,
        value: [
          {
            ID: 55,
            TimeStamp: "2026-11-27T12:00:00Z",
            Level: "ERROR",
            Logger: "TM1.Process",
            Message: "ODBCOpen failed password=SuperSecret123",
            ThreadID: 9,
            SessionID: 4,
          },
        ],
      }),
    );

    const call = captureParsedTool(registerQueryLogs, client);
    const res = (await call({
      logType: "message",
      since: "2026-11-27T00:00:00Z",
      level: "ERROR",
      logger: "TM1.Process",
      search: "ODBCOpen",
    })) as { content: Array<{ text: string }> };

    const url = decodeURIComponent(String(fetchSpy.mock.calls[0][0]));
    expect(url).toContain("/api/v1/MessageLogEntries?");
    expect(url).toContain("Level eq 'ERROR'");
    expect(url).toContain("contains(Logger,'TM1.Process')");
    expect(url).toContain("contains(Message,'ODBCOpen')");

    const payload = JSON.parse(res.content[0].text);
    expect(() => QueryLogsResultSchema.parse(payload)).not.toThrow();
    expect(payload.items[0].message).not.toContain("SuperSecret123");
  });

  it("rejects incompatible filters and invalid timestamps", async () => {
    const client = stubbedClient(makeTestConfig({ version: 11 }));
    const call = captureParsedTool(registerQueryLogs, client);

    await expect(
      call({ logType: "transaction", level: "ERROR" }),
    ).rejects.toThrow(/only apply to logType='message'/);

    await expect(
      call({ logType: "message", cubeName: "Sales" }),
    ).rejects.toThrow(/only apply to logType='transaction'/);

    await expect(
      call({ logType: "transaction", since: "not-a-date" }),
    ).rejects.toThrow(/Invalid since timestamp/);
  });
});
