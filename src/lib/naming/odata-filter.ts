// Server-side prefilter for the element naming audit.
//
// Auditing element names used to mean downloading them all: 15.2 MB for a
// single 171k-element dimension, 66 MB across a real model, and — worse — a
// cap (`maxElementsPerDim`) beyond which the audit silently checked only a
// prefix of the dimension.
//
// Every element rule in ./rules.ts is character-based, and TM1 implements the
// OData string functions those rules need (`startswith`, `endswith`,
// `contains`, `indexof`, `trim`, `length` — all verified live against 11.8).
// So the server can do the narrowing: ask it for the names that MIGHT violate
// a rule, and check only those.
//
// The contract this file must honour is SOUNDNESS, not exactness:
//
//   checkName(name) is non-empty  ⟹  the filter matches name
//
// A filter that also matches innocent names costs a few extra rows and nothing
// else, because `checkName` still decides. A filter that misses a violator
// turns the audit into a lie. `matchesElementViolationFilter` in
// tests/helpers/element-violation-filter.ts mirrors the emitted expression in
// TypeScript; tests/unit/naming-odata-filter.test.ts asserts soundness over
// every rule class, and the live suite asserts that TM1 agrees.
import { escapeOdataLiteral } from "../../tm1-client/services/odata-page.js";
import { SERVER_RESERVED_CHARS } from "./rules.js";

/** OData string literal: single quotes double. */
function lit(value: string): string {
  return `'${escapeOdataLiteral(value)}'`;
}

/**
 * `$filter` expression selecting elements that may violate a naming rule.
 *
 * Mirrors the element branch of `checkName`: empty/whitespace-only, leading or
 * trailing whitespace, TM1-Server-reserved characters, the `}` control prefix,
 * a leading `+`/`-`, and — on v12 only — an embedded TAB.
 */
export function elementViolationFilter(): string {
  const clauses = [
    // checkEmpty: name.trim() is empty. Covers "" and whitespace-only in one.
    "length(trim(Name)) eq 0",
    // checkLeadingTrailingWhitespace: name !== name.trim(). Expressed with
    // trim() rather than a list of space characters, so every whitespace
    // codepoint is covered instead of the handful someone remembered.
    "trim(Name) ne Name",
    // checkLeadingControlPrefix
    `startswith(Name,${lit("}")})`,
    // checkElementLeadingArithmetic
    `startswith(Name,${lit("+")})`,
    `startswith(Name,${lit("-")})`,
    // checkServerReservedChars — elements are in scope for these too.
    ...[...SERVER_RESERVED_CHARS].map((ch) => `contains(Name,${lit(ch)})`),
  ];

  // checkElementContainsTab applies on every version. The TAB goes in as a REAL
  // tab character: every caller passes this string through
  // encodeURIComponent(), which turns it into %09 on the wire. Writing "%09"
  // here instead produced %2509 — the server then searched for the three
  // characters "%09" and never matched, so the clause silently found nothing.
  clauses.push("indexof(Name,'\t') ge 0");

  return clauses.join(" or ");
}
