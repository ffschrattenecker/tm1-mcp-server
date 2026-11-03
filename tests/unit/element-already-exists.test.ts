import { describe, it, expect } from "vitest";
import { isAlreadyExists } from "../../src/tm1-client/services/element-service.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// Pins the cross-version "element already exists" classification (de8c806): TM1
// v11.x returns HTTP 400 with an "already exists" message where later versions
// return 409. bulkUpsert relies on this to stay idempotent — a mutation of the
// condition (e.g. dropping the 400 branch, or the substring match) would slip
// past every gate because it was only covered by the live suite, which CI never
// runs. This is that missing CI pin.
describe("isAlreadyExists", () => {
  it.each([
    ["409 Conflict", { httpStatus: 409, message: "conflict" }, true],
    [
      "400 with an 'already exists' message (v11.x)",
      {
        httpStatus: 400,
        message: "An element with name 'Region' already exists",
      },
      true,
    ],
    [
      "'already exists' only in details, not message",
      {
        httpStatus: 400,
        message: "Bad Request",
        details: "An element with that name already exists.",
      },
      true,
    ],
    [
      "'already exists' in upper case",
      { httpStatus: 400, message: "ALREADY EXISTS" },
      true,
    ],
    [
      "an unrelated 400",
      { httpStatus: 400, message: "Invalid element type ordinal" },
      false,
    ],
    [
      "a 404 that mentions 'already exists'",
      { httpStatus: 404, message: "already exists" },
      false,
    ],
  ])("%s -> %s", (_label, opts, expected) => {
    const e = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: opts.message,
      httpStatus: opts.httpStatus,
      details: "details" in opts ? opts.details : undefined,
    });
    expect(isAlreadyExists(e)).toBe(expected);
  });
});
