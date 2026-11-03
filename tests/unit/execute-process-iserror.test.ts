import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { registerExecuteProcess } from "../../src/tools/ti-development/execute-process.js";
import { captureTool } from "../helpers/client-harness.js";

// Capture the handler the tool registers, then invoke it directly with a
// stubbed TM1Client to assert the isError contract (T2.1): a TI process that
// runs but reports success:false must be surfaced as an MCP error, not a
// successful call carrying success:false.
type Args = {
  processName: string;
  parameters?: Record<string, string | number>;
  // K2/S9: execute_process carries the confirmation guard, so every call has
  // to repeat the process name — exactly as a real client would.
  confirm: string;
};

function captureHandler(
  execute: TM1Client["processes"]["execute"],
  getErrorLogContent?: (f: string) => Promise<string>,
) {
  const client = contractCheckedClient({
    processes: { execute },
    ...(getErrorLogContent ? { server: { getErrorLogContent } } : {}),
  } as unknown as TM1Client);
  return captureTool<Args>(registerExecuteProcess, client).cb;
}

describe("tm1_execute_process isError contract (T2.1)", () => {
  it("flags isError when the TI run reports success:false", async () => {
    const cb = captureHandler(async () => ({
      success: false,
      outcome: "rolled_back" as const,
      processErrorStatus: "DataSource error",
    }));
    const result = await cb(
      { processName: "Failing.Process", confirm: "Failing.Process" },
      {},
    );
    expect(result.isError).toBe(true);
    // Payload is preserved for diagnosis.
    expect(result.content[0]?.text).toContain("DataSource error");
  });

  it("flags isError when the TI run completes with minor errors", async () => {
    // execute() now routes through tm1.ExecuteWithReturn, so partial failures
    // surface as success:false with the real status + error log attached. The
    // outcome says the run's writes were COMMITTED, and isError still fires —
    // fail-closed, but the payload tells the agent not to just re-run it.
    const cb = captureHandler(async () => ({
      success: false,
      outcome: "completed_with_errors" as const,
      processErrorStatus: "HasMinorErrors",
      errorLogFile: "TM1ProcessError_20260718_Partial.log",
    }));
    const result = await cb(
      { processName: "Partial.Process", confirm: "Partial.Process" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("completed_with_errors");
    expect(result.content[0]?.text).toContain("HasMinorErrors");
    expect(result.content[0]?.text).toContain(
      "TM1ProcessError_20260718_Partial.log",
    );
  });

  it("attaches the tail of the run's own error log", async () => {
    const fetched: string[] = [];
    const log = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
      "\r\n",
    );
    const cb = captureHandler(
      async () => ({
        success: false,
        outcome: "completed_with_errors" as const,
        processErrorStatus: "HasMinorErrors",
        errorLogFile: "TM1ProcessError_x.log",
      }),
      async (f) => {
        fetched.push(f);
        return log;
      },
    );
    const out = JSON.parse(
      (await cb({ processName: "P", confirm: "P" }, {})).content[0].text,
    );
    expect(fetched).toEqual(["TM1ProcessError_x.log"]);
    expect(out.errorLog).toMatchObject({
      filename: "TM1ProcessError_x.log",
      totalLines: 50,
      truncated: true,
    });
    expect(out.errorLog.content.split("\n")).toHaveLength(40);
    expect(out.errorLog.content).toContain("line 50");
  });

  it("reports a log it could not fetch without hiding the run result", async () => {
    const cb = captureHandler(
      async () => ({
        success: false,
        outcome: "rolled_back" as const,
        processErrorStatus: "Aborted",
        errorLogFile: "TM1ProcessError_y.log",
      }),
      async () => {
        throw new Error("404");
      },
    );
    const res = await cb({ processName: "P", confirm: "P" }, {});
    const out = JSON.parse(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(out.processErrorStatus).toBe("Aborted");
    expect(out.errorLog).toEqual({
      filename: "TM1ProcessError_y.log",
      fetchError: "404",
    });
  });

  it("does not flag isError on a successful run", async () => {
    const cb = captureHandler(async () => ({
      success: true,
      outcome: "succeeded" as const,
      processErrorStatus: "CompletedSuccessfully" as const,
    }));
    const result = await cb(
      { processName: "Ok.Process", confirm: "Ok.Process" },
      {},
    );
    expect(result.isError).toBeUndefined();
  });
});

describe("tm1_execute_process abort handling (M2)", () => {
  it("swaps in an abort hint when the client cancels mid-run", async () => {
    const controller = new AbortController();
    controller.abort();
    const cb = captureHandler(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    let caught: unknown;
    try {
      await cb(
        { processName: "Long.Process", confirm: "Long.Process" },
        { signal: controller.signal },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TM1Error);
    const err = caught as TM1Error;
    expect(err.message).toContain("cancelled client-side");
    expect(err.hint).toContain("tm1_rest_read Threads");
    expect(err.hint).toContain("Threads(id)/tm1.CancelOperation");
    // The misleading "re-run after diagnosing" guidance must be gone — the TI
    // may still be running, so re-running risks a duplicate execution.
    expect(err.hint).not.toContain("diagnose_process_error");
  });
});

describe("tm1_execute_process transport hints", () => {
  // An async run that timed out is still running. The tool's own hint says to
  // diagnose and re-run — replacing the transport's hint with it would invite
  // a duplicate execution.
  it("keeps the still-running hint of a LOCK_TIMEOUT", async () => {
    const cb = captureHandler(() =>
      Promise.reject(
        new TM1Error({
          code: TM1ErrorCode.LOCK_TIMEOUT,
          message: "still running",
          hint: "Only the waiting stopped, not the run.",
        }),
      ),
    );
    const err = await cb({ processName: "P", confirm: "P" }, {}).catch(
      (e: unknown) => e,
    );
    expect((err as TM1Error).hint).toBe(
      "Only the waiting stopped, not the run.",
    );
  });
});
