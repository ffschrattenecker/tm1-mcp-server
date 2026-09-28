import { describe, it, expect } from "vitest";
import { diffDs } from "../../src/tools/ti-development/diff-processes.js";
import type { DataSource } from "../../src/types.js";

const ascii = (extra: Partial<DataSource> = {}): DataSource => ({
  type: "ASCII",
  dataSourceNameForServer: "in.csv",
  ...extra,
});

describe("diffDs", () => {
  it("sees a delimited source differ from a fixed-width one", () => {
    const r = diffDs(
      ascii({ asciiDelimiterType: "Character" }),
      ascii({ asciiDelimiterType: "FixedWidth" }),
    );
    expect(r.identical).toBe(false);
    expect(r.differences).toEqual([
      'asciiDelimiterType: "Character" → "FixedWidth"',
    ]);
  });

  it("treats a missing delimiter type as Character", () => {
    expect(
      diffDs(ascii(), ascii({ asciiDelimiterType: "Character" })).identical,
    ).toBe(true);
  });

  it("sees the ODBC unicode flag differ", () => {
    const odbc: DataSource = { type: "ODBC", dataSourceNameForServer: "DSN" };
    const r = diffDs(
      { ...odbc, usesUnicode: true },
      { ...odbc, usesUnicode: false },
    );
    expect(r.differences).toEqual(["usesUnicode: true → false"]);
  });

  it("treats a missing unicode flag as false, since v12 never returns it", () => {
    const odbc: DataSource = { type: "ODBC", dataSourceNameForServer: "DSN" };
    expect(diffDs(odbc, { ...odbc, usesUnicode: false }).identical).toBe(true);
  });
});
