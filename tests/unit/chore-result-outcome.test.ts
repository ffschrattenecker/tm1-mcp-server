// Chore run results: the classifier, and the fallback that decides whether a
// status can be reported at all.
//
// `tm1_execute_chore` used to answer `{success: true}` whenever the HTTP call
// did not throw, so a chore whose step failed reported success. This is the
// same class of defect T-4 closed for processes — see
// tests/unit/process-result-outcome.test.ts — but the mapping is NOT shared:
// the chore table is measured separately in
// tests/live/chore-exit-status.live.test.ts, because a step that aborts
// COMMITS inside a chore and rolls back outside one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type pino from "pino";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { ChoreResultSchema } from "../../src/tools/schemas/items-scheduling.js";
import { classifyChoreExecution } from "../../src/tm1-client/services/chore-status.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

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

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function mockEmpty(status = 204): Response {
  return {
    ok: true,
    status,
    statusText: "No Content",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockRejectedValue(new Error("No content")),
  } as unknown as Response;
}

function mock404(message: string): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: new Headers(),
    text: vi
      .fn()
      .mockResolvedValue(JSON.stringify({ error: { code: "", message } })),
    json: vi.fn().mockResolvedValue({ error: { code: "", message } }),
  } as unknown as Response;
}

describe("classifyChoreExecution — the measured chore table", () => {
  it("maps CompletedSuccessfully to a clean run", () => {
    const r = classifyChoreExecution(
      "CompletedSuccessfully",
      "ChoreLog_1.jsonl",
    );
    expect(r).toMatchObject({
      success: true,
      outcome: "succeeded",
      choreErrorStatus: "CompletedSuccessfully",
      errorLogFile: "ChoreLog_1.jsonl",
    });
  });

  // The heart of it: this status is what a chore returns for a step that
  // ABORTED, and the writes are committed anyway. Reporting `rolled_back` here
  // — which the process table would — invites a re-run that duplicates data.
  it("maps CompletedWithMessages to committed-with-errors, not rolled back", () => {
    const r = classifyChoreExecution("CompletedWithMessages", undefined);
    expect(r.success).toBe(false);
    expect(r.outcome).toBe("completed_with_errors");
  });

  it("maps ProcessRollbackCalled to rolled back", () => {
    const r = classifyChoreExecution("ProcessRollbackCalled", undefined);
    expect(r.success).toBe(false);
    expect(r.outcome).toBe("rolled_back");
  });

  it("reports a missing status code as indeterminate, never as success", () => {
    const r = classifyChoreExecution(undefined, undefined);
    expect(r.success).toBe(false);
    expect(r.outcome).toBe("indeterminate");
    expect(r.choreErrorStatus).toMatch(/ChoreExecuteStatusCode/);
  });

  // Declared in v12's $metadata but never produced by any measured exit path.
  // Guessing them from the process table is exactly the mistake this file
  // exists to prevent, so they stay indeterminate and say why.
  it.each(["QuitCalled", "Aborted", "RollbackCalled"])(
    "treats the declared-but-unobserved %s as indeterminate rather than guessing",
    (code) => {
      const r = classifyChoreExecution(code, undefined);
      expect(r.success).toBe(false);
      expect(r.outcome).toBe("indeterminate");
      expect(r.choreErrorStatus).toContain(code);
      expect(r.choreErrorStatus).toMatch(/never produced|unknown/i);
    },
  );

  it("treats an unrecognised code as indeterminate", () => {
    const r = classifyChoreExecution("SomeFutureCode", undefined);
    expect(r.outcome).toBe("indeterminate");
    expect(r.choreErrorStatus).toContain("SomeFutureCode");
  });

  it("produces payloads the published output schema accepts", () => {
    for (const code of [
      "CompletedSuccessfully",
      "CompletedWithMessages",
      "ProcessRollbackCalled",
      "Aborted",
      undefined,
    ]) {
      expect(() =>
        ChoreResultSchema.parse(
          classifyChoreExecution(code, "ChoreLog_1.jsonl"),
        ),
      ).not.toThrow();
    }
  });
});

describe("ChoreService.execute — reporting status where the server has it", () => {
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

  const urlOf = (call: number): string =>
    String(fetchSpy.mock.calls[call]?.[0]);

  it("expands ErrorLogFile — without it the filename is silently absent", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        ChoreExecuteStatusCode: "CompletedSuccessfully",
        ErrorLogFile: { Filename: "ChoreLog_x.jsonl" },
      }),
    );

    const r = await client.chores.execute("Nightly");

    expect(urlOf(0)).toContain("tm1.ExecuteWithReturn");
    expect(urlOf(0)).toContain("$expand=ErrorLogFile");
    expect(r).toMatchObject({
      success: true,
      outcome: "succeeded",
      errorLogFile: "ChoreLog_x.jsonl",
    });
  });

  it("reports a failing chore as failure instead of the old blanket success", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ ChoreExecuteStatusCode: "CompletedWithMessages" }),
    );

    const r = await client.chores.execute("Nightly");

    expect(r.success).toBe(false);
    expect(r.outcome).toBe("completed_with_errors");
  });

  // A build without the action answers 404 — and so does a missing chore. The
  // prose differs but is not parsed (a v11 server answers in its own language),
  // so the retry itself decides: if the plain action runs, the chore existed.
  it("falls back to tm1.Execute when the action is missing, and says status is unavailable", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mock404(
          "'tm1.ExecuteWithReturn' resource can not be resolved on type 'Chore'.",
        ),
      )
      .mockResolvedValueOnce(mockEmpty());

    const r = await client.chores.execute("Nightly");

    expect(urlOf(0)).toContain("tm1.ExecuteWithReturn");
    expect(urlOf(1)).toContain("tm1.Execute");
    expect(urlOf(1)).not.toContain("WithReturn");
    expect(r).toMatchObject({
      success: false,
      outcome: "indeterminate",
      statusUnavailable: true,
    });
    expect(r.choreErrorStatus).toMatch(/12\.5\.0/);
  });

  it("stops probing the missing action after it has learned once", async () => {
    fetchSpy
      .mockResolvedValueOnce(mock404("resource can not be resolved"))
      .mockResolvedValueOnce(mockEmpty())
      .mockResolvedValueOnce(mockEmpty());

    await client.chores.execute("Nightly");
    fetchSpy.mockClear();
    await client.chores.execute("Nightly");

    // Second run goes straight to the plain action: one call, not two.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(urlOf(0)).toContain("tm1.Execute");
    expect(urlOf(0)).not.toContain("WithReturn");
  });

  // The dangerous confusion: a 404 that really was a missing chore must not be
  // reported as "ran, status unavailable". The retry 404s too, and that error
  // is what the caller gets.
  it("surfaces the error when the chore itself is missing", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mock404("'Nope' can not be found in collection of type 'Chore'."),
      )
      .mockResolvedValueOnce(
        mock404("'Nope' can not be found in collection of type 'Chore'."),
      );

    await expect(client.chores.execute("Nope")).rejects.toThrow();
  });
});
