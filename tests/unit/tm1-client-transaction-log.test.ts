import { describe, it, expect } from "vitest";
import { toOdataDateTime } from "../../src/tm1-client/services/server-service.js";

describe("toOdataDateTime", () => {
  it("appends Z to a zoneless datetime (TM1 rejects bare datetimes)", () => {
    expect(toOdataDateTime("2026-06-08T00:00:00")).toBe("2026-06-08T00:00:00Z");
  });
  it("expands a date-only value to start-of-day UTC", () => {
    expect(toOdataDateTime("2026-06-08")).toBe("2026-06-08T00:00:00Z");
  });
  it("leaves an already-zoned value untouched", () => {
    expect(toOdataDateTime("2026-06-08T00:00:00Z")).toBe(
      "2026-06-08T00:00:00Z",
    );
    expect(toOdataDateTime("2026-06-08T00:00:00+02:00")).toBe(
      "2026-06-08T00:00:00+02:00",
    );
  });

  // S10: the function used to append "Z" to anything at all, so "yesterday"
  // became "yesterdayZ" and went straight into a $filter. TM1 then returned an
  // opaque OData parse error mentioning neither the parameter nor the value.
  it.each(["yesterday", "", "not-a-date", "2026-13-45", "08/06/2026"])(
    "rejects unparseable input %o instead of shipping it to OData",
    (bad) => {
      expect(() => toOdataDateTime(bad)).toThrow(/Not a usable timestamp/);
    },
  );

  it("names the offending value in the error", () => {
    expect(() => toOdataDateTime("yesterday")).toThrow(/'yesterday'/);
  });
});
