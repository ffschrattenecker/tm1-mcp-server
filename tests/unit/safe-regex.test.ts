import { describe, it, expect } from "vitest";
import { compileUserRegex } from "../../src/lib/safe-regex.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

describe("compileUserRegex", () => {
  it("compiles a safe pattern and applies flags", () => {
    const re = compileUserRegex("^cube_[0-9]+$", "i", "nameRegex");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.flags).toBe("i");
    expect(re.test("CUBE_42")).toBe(true);
    expect(re.test("nope")).toBe(false);
  });

  it("rejects catastrophic-backtracking patterns (ReDoS) as VALIDATION_ERROR", () => {
    try {
      compileUserRegex("(a+)+$", undefined, "pattern");
      throw new Error("expected compileUserRegex to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TM1Error);
      expect((e as TM1Error).code).toBe(TM1ErrorCode.VALIDATION_ERROR);
      expect((e as TM1Error).message).toMatch(/backtracking|ReDoS/i);
    }
  });

  // safe-regex only measures star height and passed these; ^(\w|\w)*!$ ran
  // 23.5 s on 30 characters and blocked the event loop.
  it.each([
    "^(\\w|\\w)*!$",
    "^(a|a)*$",
    "(a|ab)+c",
    "(?:x|y){2,}z",
    "a/(b|c)*",
  ])("rejects repeated alternation %s", (pattern) => {
    expect(() => compileUserRegex(pattern)).toThrow(/ReDoS/);
  });

  it.each(["^(Load|Init)_.*$", "(a|b)?c", "(a|b){1,3}", "[ab]+", "a\\/b"])(
    "still accepts %s",
    (pattern) => {
      expect(compileUserRegex(pattern, "i")).toBeInstanceOf(RegExp);
    },
  );

  it("rejects unparseable patterns as VALIDATION_ERROR", () => {
    try {
      compileUserRegex("([unbalanced", undefined, "nameRegex");
      throw new Error("expected compileUserRegex to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TM1Error);
      expect((e as TM1Error).code).toBe(TM1ErrorCode.VALIDATION_ERROR);
    }
  });
});
