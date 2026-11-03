import { describe, it, expect } from "vitest";
import {
  parseLogName,
  formatTs,
  spanDays,
} from "../../src/tools/operations/list-error-logs.js";

describe("parseLogName", () => {
  it("parses modern v11 pattern with base36 session hash", () => {
    // Real-world v11 hash: lowercase base36, ~12 chars, contains digits.
    expect(
      parseLogName(
        "TM1ProcessError_20260513174354_81004880_LoadActuals_mp4clzmld56v.log",
      ),
    ).toEqual({
      ts: "20260513174354",
      process: "LoadActuals",
    });
  });

  it("parses the v12 ProcessLog pattern without stripping a hash-like tail", () => {
    expect(
      parseLogName(
        "ProcessLog_20260925184908_17903621480006_Load_x1y2z3w4.jsonl",
      ),
    ).toEqual({
      ts: "20260925184908",
      process: "Load_x1y2z3w4",
    });
  });

  it("parses modern v11 pattern without hash", () => {
    expect(
      parseLogName("TM1ProcessError_20260615123045_42_LoadActuals.log"),
    ).toEqual({
      ts: "20260615123045",
      process: "LoadActuals",
    });
  });

  it("keeps underscores inside the process name (strips only the hash)", () => {
    expect(
      parseLogName(
        "TM1ProcessError_20260615123045_7_Sales_Load_Daily_mp2su7f4sybb.log",
      ),
    ).toEqual({
      ts: "20260615123045",
      process: "Sales_Load_Daily",
    });
  });

  it("collapses TIRecord variants with control-object proc name", () => {
    const a = parseLogName(
      "TM1ProcessError_20260512154239_111_TIRecord_}bedrock.hier.sub.delete_mp2su7f4sybb.log",
    );
    const b = parseLogName(
      "TM1ProcessError_20260512205706_222_TIRecord_}bedrock.hier.sub.delete_mp342kxn9gv3.log",
    );
    expect(a.process).toBe("TIRecord_}bedrock.hier.sub.delete");
    expect(b.process).toBe("TIRecord_}bedrock.hier.sub.delete");
    expect(a.process).toBe(b.process);
  });

  it("does NOT strip an all-letter trailing token (no digit → real proc suffix)", () => {
    expect(
      parseLogName("TM1ProcessError_20260615123045_7_Cube_Inputs.Export.log"),
    ).toEqual({
      ts: "20260615123045",
      process: "Cube_Inputs.Export",
    });
  });

  it("parses legacy <proc>_<ts> pattern", () => {
    expect(parseLogName("MyProc_20260615123045.log")).toEqual({
      ts: "20260615123045",
      process: "MyProc",
    });
  });

  it("returns nulls for an unrecognised filename", () => {
    expect(parseLogName("random.txt")).toEqual({ process: null, ts: null });
  });
});

describe("formatTs and spanDays", () => {
  // prettier-ignore
  it.each<[string, () => unknown, unknown]>([
    ["formatTs: 14-digit timestamp", () => formatTs("20260615123045"), "2026-06-15T12:30:45"],
    ["formatTs: 8-digit date pads time", () => formatTs("20260615"), "2026-06-15T00:00:00"],
    ["formatTs: null input", () => formatTs(null), null],
    ["formatTs: too-short input", () => formatTs("2026"), null],
    ["spanDays: same day", () => spanDays("20260615000000", "20260615235959"), 1],
    ["spanDays: inclusive range", () => spanDays("20260601000000", "20260605000000"), 5],
    ["spanDays: unparseable falls back to 1", () => spanDays("bogus", "20260605000000"), 1],
  ])("%s", (_name, call, expected) => {
    expect(call()).toEqual(expected);
  });
});
