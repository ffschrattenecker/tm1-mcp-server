// T-4 — execution results that cannot express failure.
//
// Two defects, one type:
//   1. `?? "CompletedSuccessfully"` made a MISSING ProcessExecuteStatusCode
//      mean "the process ran fine". A server that answers without the field —
//      or with an empty body — was reported to the model as a successful run.
//      The honest reading is that the outcome is UNKNOWN.
//   2. `{success: true, processErrorStatus: "Aborted"}` was a representable
//      value. Nothing in the type stopped a future edit from producing it.
//
// `ProcessResult` is now a discriminated union: `success` is a literal per
// variant, `outcome` names the third state, and the success variant pins
// `processErrorStatus` to the one status that can accompany it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { type TM1Client } from "../../src/tm1-client.js";
import type { ProcessResult } from "../../src/types.js";
import { ProcessResultSchema } from "../../src/tools/schemas/items-processes.js";
import { classifyExecution } from "../../src/tm1-client/services/process-status.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockResponse, stubbedClient } from "../helpers/client-harness.js";

function mockEmptyBody(status = 200): Response {
  return {
    ok: true,
    status,
    statusText: status === 200 ? "OK" : "No Content",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockRejectedValue(new Error("No content")),
  } as unknown as Response;
}

describe("ProcessResult — a missing status code is not success (T-4)", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    const config = makeTestConfig({ requestTimeoutMs: 5000 });
    client = stubbedClient(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // A live server always sends the field (tests/live/process.live.test.ts), so
  // every row here means we genuinely do not know the outcome. The status text
  // is the only channel the tool has for saying so.
  it.each([
    [
      "a body without ProcessExecuteStatusCode",
      () => mockResponse({ ErrorLogFile: null }),
      (c: TM1Client) => c.processes.execute("ImportData"),
    ],
    [
      "an empty 200 body",
      () => mockEmptyBody(200),
      (c: TM1Client) => c.processes.execute("RunCalc"),
    ],
    [
      "a 204 No Content",
      () => mockEmptyBody(204),
      (c: TM1Client) => c.processes.execute("RunCalc"),
    ],
    [
      "a 204 from saveData",
      () => mockEmptyBody(204),
      (c: TM1Client) => c.processes.saveData(),
    ],
  ])(
    "reports %s as indeterminate, not as a successful run",
    async (_label, respond, call) => {
      fetchSpy.mockResolvedValueOnce(respond());

      const result = await call(client);

      expect(result.success).toBe(false);
      expect(result.outcome).toBe("indeterminate");
      expect(result.processErrorStatus).toMatch(/ProcessExecuteStatusCode/);
    },
  );

  it("labels a TM1 error response indeterminate and keeps the server text", async () => {
    // The call errored, so TM1 never reported a status — and an error raised
    // mid-run tells us nothing about whether the run committed. Claiming a
    // rollback we did not observe would be the same fail-open mistake in a
    // different direction.
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ error: { message: "Prolog aborted" } }, 400),
    );

    const result = await client.processes.execute("Broken");

    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
    expect(result.processErrorStatus).toContain("Prolog aborted");
  });
});

// One case per member of tm1.ProcessExecuteStatusCode. The enum has exactly
// six (read from the $metadata of both an 11.8 and a 12.5.9 server — identical,
// no version drift), and the grouping below is the live-measured commit
// behaviour, not a reading of the names: a marker cell written in the Prolog
// survived ItemReject and ProcessQuit, and was gone after ProcessError and
// ProcessRollback. HasMinorErrors too: its documented path is per-record
// failures in the Metadata/Data tabs (which need a data source), but a Prolog
// write to a consolidated element produces the same code without one — and the
// marker survived, so it belongs with the committed group.
describe("classifyExecution — one row per ProcessExecuteStatusCode", () => {
  it.each([
    ["CompletedSuccessfully", "succeeded", true],
    ["HasMinorErrors", "completed_with_errors", false],
    ["QuitCalled", "completed_with_errors", false],
    ["CompletedWithMessages", "completed_with_errors", false],
    ["Aborted", "rolled_back", false],
    ["RollbackCalled", "rolled_back", false],
  ] as const)("maps %s to %s (success=%s)", (status, outcome, success) => {
    const result = classifyExecution(status, undefined);
    expect(result.outcome).toBe(outcome);
    expect(result.success).toBe(success);
    expect(result.processErrorStatus).toBe(status);
  });

  it("carries the error log file through unchanged", () => {
    const result = classifyExecution("Aborted", "TM1ProcessError_y.log");
    expect(result.errorLogFile).toBe("TM1ProcessError_y.log");
  });

  it("maps a status code this build does not know to indeterminate", () => {
    // A seventh member added by a future TM1 must not be absorbed into a group
    // whose commit semantics we never measured — that is how the old
    // everything-else-is-failed branch would have swallowed it.
    const result = classifyExecution("SomeFutureStatus", undefined);
    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
    expect(result.processErrorStatus).toContain("SomeFutureStatus");
    expect(result.processErrorStatus).toMatch(/unrecognised/i);
  });

  it.each([
    ["a missing status code", undefined],
    ["an empty status code", ""],
  ])("maps %s to indeterminate (T-4)", (_label, status) => {
    const result = classifyExecution(status, undefined);
    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
  });
});

describe("ProcessResult — contradictory states are unrepresentable (T-4)", () => {
  it("rejects {success: true} paired with a failure status at compile time", () => {
    // @ts-expect-error success:true can only carry "CompletedSuccessfully"
    const contradiction: ProcessResult = {
      success: true,
      outcome: "succeeded",
      processErrorStatus: "Aborted",
    };
    expect(contradiction.processErrorStatus).toBe("Aborted");
  });

  it("narrows on `success` without a cast", () => {
    const results: ProcessResult[] = [
      {
        success: true,
        outcome: "succeeded",
        processErrorStatus: "CompletedSuccessfully",
      },
      { success: false, outcome: "rolled_back", processErrorStatus: "Aborted" },
    ];
    const statuses = results.map((r) =>
      r.success ? r.processErrorStatus : `!${r.processErrorStatus}`,
    );
    expect(statuses).toEqual(["CompletedSuccessfully", "!Aborted"]);
  });
});

describe("ProcessResultSchema carries the new field (strict output gate)", () => {
  it.each([
    [
      "the indeterminate payload the handler returns",
      {
        success: false,
        outcome: "indeterminate",
        processErrorStatus: "Unknown: TM1 returned no ProcessExecuteStatusCode",
      },
      true,
    ],
    [
      "a successful payload",
      {
        success: true,
        outcome: "succeeded",
        processErrorStatus: "CompletedSuccessfully",
      },
      true,
    ],
    [
      "a completed_with_errors payload",
      {
        success: false,
        outcome: "completed_with_errors",
        processErrorStatus: "QuitCalled",
      },
      true,
    ],
    [
      "a rolled_back payload",
      {
        success: false,
        outcome: "rolled_back",
        processErrorStatus: "QuitCalled",
      },
      true,
    ],
    [
      "an unknown outcome value",
      { success: false, outcome: "probably-fine", processErrorStatus: "?" },
      false,
    ],
  ])("accepts or rejects %s", (_label, payload, valid) => {
    expect(ProcessResultSchema.safeParse(payload).success).toBe(valid);
  });
});
