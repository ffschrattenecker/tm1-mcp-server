import { describe, it, expect } from "vitest";
import { checkName, parseMajorVersion } from "../../src/lib/naming/rules.js";

describe("checkName — cube/dim/process (server-reserved kinds)", () => {
  it("accepts a clean name", () => {
    expect(checkName("Sales", "cube")).toEqual([]);
    expect(checkName("Product", "dimension")).toEqual([]);
    expect(checkName("Load_Actuals", "process")).toEqual([]);
  });

  it.each([
    ["a/b", "/"],
    ["a\\b", "\\"],
    ["a:b", ":"],
    ["a*b", "*"],
    ["a?b", "?"],
    ['a"b', '"'],
    ["a<b", "<"],
    ["a>b", ">"],
    ["a|b", "|"],
    ["a'b", "'"],
    ["a;b", ";"],
    ["a,b", ","],
  ])("flags server-reserved char in '%s' (%s)", (name, ch) => {
    const v = checkName(name, "cube");
    expect(
      v.some((x) => x.rule === "server_reserved_char" && x.char === ch),
    ).toBe(true);
  });

  it("flags control prefix '}'", () => {
    const v = checkName("}MyCube", "cube");
    expect(v.some((x) => x.rule === "leading_control_prefix")).toBe(true);
  });

  it.each([" Sales", "Sales "])(
    "flags leading/trailing whitespace in '%s'",
    (name) => {
      expect(
        checkName(name, "cube").some(
          (x) => x.rule === "leading_trailing_whitespace",
        ),
      ).toBe(true);
    },
  );

  it.each(["", "   "])("flags empty / whitespace-only name '%s'", (name) => {
    expect(checkName(name, "cube")[0]?.rule).toBe("empty");
  });

  it("flags length > 256", () => {
    const long = "x".repeat(257);
    expect(
      checkName(long, "cube").some((x) => x.rule === "length_exceeds"),
    ).toBe(true);
  });
});

describe("checkName — element (PA 2.0 v11)", () => {
  it("accepts a clean element name", () => {
    expect(checkName("Jan", "element")).toEqual([]);
  });

  it.each(["+Special", "-Special"])(
    "flags leading '+' or '-' in '%s'",
    (name) => {
      expect(checkName(name, "element")[0]?.rule).toBe(
        "element_leading_arithmetic",
      );
    },
  );

  it("flags TAB in element names", () => {
    // 11.8 and 12.5 both accept a TAB and keep the name verbatim, so the rule
    // is naming hygiene rather than a v12 migration check — and no longer
    // takes a version at all.
    const v = checkName("a\tb", "element");
    expect(v.some((x) => x.rule === "element_contains_tab")).toBe(true);
  });

  it("flags reserved chars in elements", () => {
    const v = checkName("Foo;Bar", "element");
    expect(v.some((x) => x.rule === "server_reserved_char")).toBe(true);
  });

  it("does NOT flag length on long element names (no hard server limit)", () => {
    const long = "e".repeat(500);
    const v = checkName(long, "element");
    expect(v.some((x) => x.rule === "length_exceeds")).toBe(false);
  });

  it("does NOT flag length on long attribute names", () => {
    const long = "a".repeat(500);
    const v = checkName(long, "attribute");
    expect(v.some((x) => x.rule === "length_exceeds")).toBe(false);
  });
});

describe("checkName — processVariable", () => {
  it("accepts a valid TI identifier", () => {
    expect(checkName("vDate", "processVariable")).toEqual([]);
    expect(checkName("v_Account.1", "processVariable")).toEqual([]);
  });

  it.each([
    ["1var", "process_var_leading_non_letter"],
    ["_v", "process_var_leading_non_letter"],
    ["v-name", "process_var_invalid_char"],
    ["v name", "process_var_invalid_char"],
    ["v@name", "process_var_invalid_char"],
    ["", "empty"],
  ])("rejects '%s' with %s", (name, rule) => {
    expect(checkName(name, "processVariable")[0]?.rule).toBe(rule);
  });
});

describe("parseMajorVersion", () => {
  it.each([
    ["11.8.01100", 11],
    ["12.0.0", 12],
    // Anything at or above 12 is treated as v12.
    ["13.5.0", 12],
    // Empty or unparseable falls back to v11.
    ["", 11],
    ["foo", 11],
  ])("parses %j as v%i", (input, major) => {
    expect(parseMajorVersion(input)).toBe(major);
  });
});
