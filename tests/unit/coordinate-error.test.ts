import { describe, it, expect } from "vitest";
import { dimensionCountMismatch } from "../../src/lib/coordinate-error.js";
import { TM1ErrorCode } from "../../src/types.js";

describe("dimensionCountMismatch", () => {
  const dims = ["Sandboxes", "Version", "Year", "Account", "Measure"];

  it("names the cube's dimension order and the uncovered positions", () => {
    const err = dimensionCountMismatch("Sales", dims, [
      "Actual",
      "2026",
      "Revenue",
      "Value",
    ]);
    expect(err.code).toBe(TM1ErrorCode.VALIDATION_ERROR);
    expect(err.message).toContain("has 5 dimensions but 4 element(s)");
    expect(err.message).toContain("(by position): Measure");
    // The order is what shows the caller it forgot Sandboxes up front.
    expect(err.hint).toContain(
      "in this order: Sandboxes, Version, Year, Account, Measure",
    );
    expect(JSON.parse(err.details!)).toEqual([
      { dimension: "Sandboxes", element: "Actual" },
      { dimension: "Version", element: "2026" },
      { dimension: "Year", element: "Revenue" },
      { dimension: "Account", element: "Value" },
      { dimension: "Measure", element: null },
    ]);
  });

  it("lists surplus elements when too many are given", () => {
    const err = dimensionCountMismatch("C", ["A", "B"], ["a", "b", "c"]);
    expect(err.message).toContain("1 element(s) too many: c");
  });
});
