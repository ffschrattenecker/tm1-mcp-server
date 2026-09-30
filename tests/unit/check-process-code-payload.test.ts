import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerCheckProcessCode } from "../../src/tools/ti-development/check-process-code.js";
import { captureTool } from "../helpers/client-harness.js";

// Syntax errors are the expected output of this validator. The failure payload
// must carry its own code/message/hint so the isError normalizer does not
// stamp a generic TM1_ERROR envelope (with the whole payload duplicated into
// `message`) over it — observed in the 2026-07-04 prod live sweep.
function captureHandler(check: TM1Client["processes"]["check"]) {
  const client = contractCheckedClient({
    processes: { check },
  } as unknown as TM1Client);
  return captureTool<{ processName?: string; prolog?: string }>(
    registerCheckProcessCode,
    client,
  ).cb;
}

describe("tm1_check_process_code failure payload", () => {
  it("carries code/message/hint alongside the compile errors", async () => {
    const cb = captureHandler(async () => ({
      success: false,
      errors: [
        { lineNumber: 2, procedure: "Prolog", message: "missing bracket" },
      ],
    }));
    const result = await cb({ processName: "_probe", prolog: "nX = (" }, {});
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.errorCount).toBe(1);
    expect(payload.errors[0].message).toBe("missing bracket");
    expect(payload.code).toBe("VALIDATION_ERROR");
    expect(payload.message).toBe("TI syntax check failed: 1 error(s)");
    expect(payload.hint).toContain("errors[]");
  });

  it("keeps the success payload free of error envelope fields", async () => {
    const cb = captureHandler(async () => ({ success: true, errors: [] }));
    const result = await cb({ processName: "_probe", prolog: "nX = 1;" }, {});
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(payload.code).toBeUndefined();
    expect(payload.message).toBeUndefined();
    expect(payload.hint).toBeUndefined();
  });
});

describe("tm1_check_process_code coverage", () => {
  it("marks a fragment as partial and names the tabs it saw", async () => {
    const cb = captureHandler(async () => ({ success: true, errors: [] }));
    const payload = JSON.parse(
      (await cb({ prolog: "nX = 1;" }, {})).content[0].text,
    );
    expect(payload.tabsChecked).toEqual(["prolog"]);
    expect(payload.partial).toBe(true);
  });

  it("is complete when all four tabs are passed, empty ones included", async () => {
    const cb = captureHandler(async () => ({ success: true, errors: [] }));
    const args = { prolog: "nX = 1;", metadata: "", data: "", epilog: "" };
    const payload = JSON.parse((await cb(args, {})).content[0].text);
    expect(payload.tabsChecked).toEqual([
      "prolog",
      "metadata",
      "data",
      "epilog",
    ]);
    expect(payload.partial).toBe(false);
  });
});
