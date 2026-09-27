import { describe, it, expect } from "vitest";
import { tm1NameEquals, tm1NameKey } from "../../src/lib/tm1-name.js";

describe("tm1NameKey / tm1NameEquals", () => {
  it("ignores case and spaces, as TM1 does", () => {
    expect(tm1NameKey("Total Year")).toBe("totalyear");
    expect(tm1NameEquals("Total Year", "TOTALYEAR")).toBe(true);
    expect(tm1NameEquals(" a b ", "AB")).toBe(true);
  });

  it("keeps every other character significant", () => {
    expect(tm1NameEquals("a_b", "ab")).toBe(false);
    expect(tm1NameEquals("a-b", "a b")).toBe(false);
  });
});
