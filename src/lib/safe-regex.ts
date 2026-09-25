import safeRegex from "safe-regex";
import regexpTree from "regexp-tree";
import { TM1Error, TM1ErrorCode } from "../types.js";

/**
 * Compile a user-supplied regex behind a ReDoS guard.
 *
 * Every `new RegExp(<user/LLM input>)` site must route through this helper:
 * `safe-regex` rejects catastrophic-backtracking patterns (e.g. `(a+)+$`) before
 * the pattern is ever constructed, so a malicious caller cannot freeze the Node
 * event loop and DoS the server. Invalid patterns are normalized to a
 * VALIDATION_ERROR instead of surfacing as a raw SyntaxError.
 *
 * @param pattern user-supplied regex source
 * @param flags   optional RegExp flags (e.g. "i", "gi")
 * @param label   human label for error messages (e.g. "nameRegex"); defaults to "regex"
 */
interface AstNode {
  type?: string;
  quantifier?: { kind: string; to?: number };
  [key: string]: unknown;
}

/**
 * Unbounded repetition over a group that contains `|`, e.g. `(\w|\w)*` or
 * `(a|ab)+`. safe-regex measures only star height, so it passes these, yet
 * overlapping branches backtrack exponentially: `^(\w|\w)*!$` took 23.5 s on
 * 30 characters and froze the event loop. Rejected as a class, since telling
 * overlapping from disjoint branches is itself a hard problem; a character
 * class (`[ab]+`) expresses the common intent without the risk.
 */
function hasRepeatedAlternation(pattern: string): boolean {
  let ast: AstNode;
  try {
    // Parsing a RegExp object avoids re-escaping `/`; compiling never runs it.
    ast = regexpTree.parse(new RegExp(pattern)) as unknown as AstNode;
  } catch {
    return false; // new RegExp() below reports the syntax error
  }
  const containsDisjunction = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    if ((n as AstNode).type === "Disjunction") return true;
    return Object.values(n).some(containsDisjunction);
  };
  const walk = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    const node = n as AstNode;
    if (
      node.type === "Repetition" &&
      node.quantifier &&
      (node.quantifier.kind !== "Range" || node.quantifier.to === undefined) &&
      node.quantifier.kind !== "?" &&
      containsDisjunction(node.expression)
    ) {
      return true;
    }
    return Object.values(node).some(walk);
  };
  return walk(ast);
}

export function compileUserRegex(
  pattern: string,
  flags?: string,
  label = "regex",
): RegExp {
  if (!safeRegex(pattern) || hasRepeatedAlternation(pattern)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${label} rejected: pattern risks catastrophic backtracking (ReDoS).`,
      details: pattern,
      hint: "Avoid nested unbounded quantifiers like (a+)+ or (.*)*, and repeating an alternation like (a|b)* — use a character class ([ab]*) or simplify the pattern.",
    });
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Invalid ${label}: ${(e as Error).message}`,
      details: pattern,
      hint: "Pattern must be a valid JavaScript regex. Escape backslashes and balance brackets/parens.",
    });
  }
}
