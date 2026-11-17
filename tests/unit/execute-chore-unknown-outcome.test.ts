import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { registerExecuteChore } from "../../src/tools/scheduling/execute-chore.js";
import { captureTool } from "../helpers/client-harness.js";

// When the chore's POST never got a final answer, the run may already be
// executing. The generic hint ("retry after the lock clears") would invite a
// duplicate run, so the tool replaces it with one that says so.
type Args = { choreName: string; confirm: string };

function captureHandler(
  execute: TM1Client["chores"]["execute"],
  version: 11 | 12 = 11,
) {
  const client = contractCheckedClient({
    version,
    chores: { execute },
  } as unknown as TM1Client);
  return captureTool<Args>(registerExecuteChore, client).cb;
}

describe("tm1_execute_chore unknown outcome", () => {
  it.each([
    [
      "a timeout",
      () =>
        new TM1Error({
          code: TM1ErrorCode.LOCK_TIMEOUT,
          message: "timed out after 30000ms",
        }),
    ],
    [
      "a lost connection",
      () =>
        new TM1Error({
          code: TM1ErrorCode.CONNECTION_FAILED,
          message: "fetch failed",
        }),
    ],
    [
      "a 500",
      () =>
        new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "Internal Server Error",
          httpStatus: 500,
        }),
    ],
  ])("says the chore may be running after %s", async (_n, mk) => {
    const cb = captureHandler(async () => {
      throw mk();
    });
    await expect(
      cb({ choreName: "Nightly", confirm: "Nightly" }, {}),
    ).rejects.toMatchObject({
      code: mk().code,
      hint: expect.stringContaining("may or may not have started"),
    });
  });

  it("points at Threads on v11 and Jobs on v12", async () => {
    const failing = async () => {
      throw new TM1Error({
        code: TM1ErrorCode.CONNECTION_FAILED,
        message: "fetch failed",
      });
    };
    const v11 = captureHandler(failing, 11);
    const v12 = captureHandler(failing, 12);
    await expect(
      v11({ choreName: "Nightly", confirm: "Nightly" }, {}),
    ).rejects.toMatchObject({ hint: expect.stringContaining("Threads") });
    await expect(
      v12({ choreName: "Nightly", confirm: "Nightly" }, {}),
    ).rejects.toMatchObject({ hint: expect.stringContaining("Jobs") });
  });

  it("leaves an error TM1 answered with untouched", async () => {
    const cb = captureHandler(async () => {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: "no such chore",
        httpStatus: 404,
      });
    });
    let caught: unknown;
    try {
      await cb({ choreName: "Nope", confirm: "Nope" }, {});
    } catch (e) {
      caught = e;
    }
    expect((caught as TM1Error).hint).not.toContain("may or may not");
  });
});
