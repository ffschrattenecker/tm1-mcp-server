import { SERVER_RESERVED_CHARS } from "../../src/lib/naming/rules.js";

/**
 * `elementViolationFilter()` evaluated in TypeScript, for testing its
 * soundness against `checkName` without a server and for mocks that emulate
 * TM1 applying the `$filter`. Mirror any clause added to the builder here: a
 * rule added to one and forgotten in the other fails the soundness test.
 */
export function matchesElementViolationFilter(name: string): boolean {
  if (name.trim().length === 0) return true;
  if (name !== name.trim()) return true;
  if (name.startsWith("}")) return true;
  if (name.startsWith("+") || name.startsWith("-")) return true;
  for (const ch of SERVER_RESERVED_CHARS) if (name.includes(ch)) return true;
  if (name.includes("\t")) return true;
  return false;
}
