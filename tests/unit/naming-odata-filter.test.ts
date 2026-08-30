// The naming audit asks TM1 for the elements that might violate a rule
// instead of downloading every element name. That only works if the filter is
// SOUND: it may return names that turn out fine, but it must never omit a name
// `checkName` would flag. These tests pin exactly that property — the filter is
// a prefilter, `checkName` stays the authority.
import { describe, it, expect } from "vitest";
import { checkName } from "../../src/lib/naming/rules.js";
import {
  elementViolationFilter,
  matchesElementViolationFilter,
} from "../../src/lib/naming/odata-filter.js";

// Names that violate at least one element rule, one per rule class plus the
// awkward cases (quote doubling, unicode whitespace, tab).
const VIOLATING = [
  "",
  "   ",
  " leading",
  "trailing ",
  "\ttabbed",
  "}Control",
  "+plus",
  "-minus",
  "back\\slash",
  "fwd/slash",
  "colon:here",
  "star*here",
  "quest?here",
  'quote"here',
  "lt<here",
  "gt>here",
  "pipe|here",
  "apo'strophe",
  "semi;colon",
  "comma,here",
  "mid\tdle",
];

const CLEAN = [
  "Sales",
  "Total_Revenue",
  "2026",
  "Kosten (netto)",
  "a-b", // hyphen only leads a violation at position 0
  "München",
  "x".repeat(300), // elements have no length cap
];

describe("elementViolationFilter", () => {
  it("is sound: every name checkName flags is matched", () => {
    for (const name of VIOLATING) {
      const flagged = checkName(name, "element").length > 0;
      expect(flagged, `${JSON.stringify(name)} should violate a rule`).toBe(
        true,
      );
      expect(
        matchesElementViolationFilter(name),
        `filter must not miss ${JSON.stringify(name)}`,
      ).toBe(true);
    }
  });

  it("does not flag clean names, so the fetched candidate set stays small", () => {
    // Not a correctness requirement — an over-wide filter would still produce
    // the right answer, just a bigger download. Worth pinning anyway.
    for (const name of CLEAN) {
      expect(
        matchesElementViolationFilter(name),
        `${JSON.stringify(name)} should not be a candidate`,
      ).toBe(false);
    }
  });

  it("looks for TAB unconditionally, matching checkName", () => {
    // Measured on 11.8 and 12.5: both accept a TAB in an element name and keep
    // it verbatim, so neither the rule nor the prefilter is version-gated.
    expect(matchesElementViolationFilter("mid\tdle")).toBe(true);
    expect(
      checkName("mid\tdle", "element").some(
        (v) => v.rule === "element_contains_tab",
      ),
    ).toBe(true);
  });

  it("doubles a single quote, the one literal OData can misparse", () => {
    const f = elementViolationFilter();
    expect(f).toContain("contains(Name,'''')");
  });

  it("expresses whitespace with trim() rather than a space list", () => {
    // `name !== name.trim()` covers every unicode space JS trims. Enumerating
    // them as startswith/endswith clauses would silently miss the ones nobody
    // thought of, which is the failure mode this filter must not have.
    const f = elementViolationFilter();
    expect(f).toContain("trim(Name) ne Name");
    expect(f).toContain("length(trim(Name)) eq 0");
  });

  it("emits a real TAB that survives the caller's encodeURIComponent as %09", () => {
    // The only caller (scanElementNames) encodes the whole filter. Writing the
    // literal "%09" here produced "%2509" on the wire, so the server searched
    // for three characters and the clause silently matched nothing — the tab
    // prefilter never worked. Assert the wire form, not the source form.
    const f = elementViolationFilter();
    expect(f).toContain("indexof(Name,'\t')");
    expect(encodeURIComponent(f)).toContain("indexof(Name%2C'%09')");
    expect(encodeURIComponent(f)).not.toContain("%2509");
  });
});
