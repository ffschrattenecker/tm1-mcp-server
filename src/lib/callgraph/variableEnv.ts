/**
 * Per-process variable environment.
 *
 * Classifies each assignment `var = expression;` as
 *   - literal    (string literal or numeric literal)
 *   - param      (reference to a process parameter, directly or via another local variable that is a param)
 *   - dynamic    (everything else — CellGet, concatenation, function calls, IF, loops)
 *
 * Multi-assignment (a variable is assigned different values) → dynamic,
 * because the value is no longer unambiguous at any given call site.
 */

import { TI_VAR } from "../ti-identifier.js";
import { neutralizeLine } from "./rulesLinter.js";

export type VarBinding =
  | { kind: "literal"; value: string } // resolved literal value (string content without quotes, or numeric text)
  | { kind: "param"; paramName: string } // value comes directly from a process parameter
  | { kind: "dynamic" }; // cannot resolve (computed/IF/CellGet/concat/etc.)

export interface ProcessEnv {
  /** Parameter names of this process (lowercase). */
  paramsLc: Set<string>;
  /** Original-cased param names (for display). Map from lowercase → original. */
  paramOriginal: Map<string, string>;
  /** Local variable bindings (varname lowercase → resolved binding). */
  vars: Map<string, VarBinding>;
}

const STRING_LITERAL_RE = /^'([^']*)'$/;
const NUMERIC_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;
const IDENTIFIER_RE = new RegExp(`^${TI_VAR}$`);

const SECTION_MARKER_RE = /^57[2345],\d*$/;

/**
 * Split an expression on top-level '|' (TI string-concat), ignoring '|' inside
 * 'string literals' or (parens). A single-element result means no top-level '|'
 * was found (not a concatenation).
 */
function splitTopLevelConcat(expr: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inStr = false;
  let depth = 0;
  for (const ch of expr) {
    if (ch === "'") {
      inStr = !inStr;
      cur += ch;
    } else if (!inStr && ch === "(") {
      depth++;
      cur += ch;
    } else if (!inStr && ch === ")") {
      depth--;
      cur += ch;
    } else if (!inStr && depth === 0 && ch === "|") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Classify a single right-hand-side expression (no surrounding whitespace).
 * Only handles simple cases:
 *   'literal', 42, varName (→ lookup), paramName (→ param-ref).
 * Constant string-concatenation (all operands resolve to literals) folds to a literal.
 * Everything else (function calls, concatenation with any non-literal operand, arithmetic, IF, brackets) → dynamic.
 */
export function resolveExpression(expr: string, env: ProcessEnv): VarBinding {
  const e = expr.trim().replace(/;+$/, "").trim();

  // String literal
  const strM = STRING_LITERAL_RE.exec(e);
  if (strM) {
    return { kind: "literal", value: strM[1]! };
  }

  // Numeric literal
  if (NUMERIC_LITERAL_RE.test(e)) {
    return { kind: "literal", value: e };
  }

  // Bare identifier — could be param, a DataSource var, or a previously-assigned local var
  if (IDENTIFIER_RE.test(e)) {
    const lc = e.toLowerCase();
    if (env.paramsLc.has(lc)) {
      return {
        kind: "param",
        paramName: env.paramOriginal.get(lc) ?? e,
      };
    }
    const bound = env.vars.get(lc);
    if (bound) {
      return bound;
    }
    // Unknown identifier — treat as dynamic (could be a global, a later-assigned var, etc.)
    return { kind: "dynamic" };
  }

  // Constant string-concatenation: fold if every operand resolves to a literal.
  const parts = splitTopLevelConcat(e);
  if (parts.length >= 2) {
    const values: string[] = [];
    for (const part of parts) {
      const resolved = resolveExpression(part, env);
      if (resolved.kind !== "literal") {
        return { kind: "dynamic" };
      }
      values.push(resolved.value);
    }
    return { kind: "literal", value: values.join("") };
  }

  return { kind: "dynamic" };
}

/**
 * Build a process env from TI text and the process's parameter names.
 * Processes assignments top-down; multi-assignments are demoted to dynamic.
 */
export function buildProcessEnv(
  text: string,
  paramNames: string[],
): ProcessEnv {
  const paramsLc = new Set(paramNames.map((p) => p.toLowerCase()));
  const paramOriginal = new Map(
    paramNames.map((p) => [p.toLowerCase(), p] as const),
  );

  const env: ProcessEnv = {
    paramsLc,
    paramOriginal,
    vars: new Map(),
  };

  const assignedOnce = new Map<string, VarBinding>();
  const seen = new Set<string>();

  const assignRe = new RegExp(
    `^\\s*(${TI_VAR})\\s*=\\s*(.+?)\\s*;?\\s*(?:#.*)?$`,
  );
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/\r$/, "");
    if (SECTION_MARKER_RE.test(line.trim()) || line.trim() === "") {
      continue;
    }

    // Skip comment-only lines
    if (neutralizeLine(line).trim() === "") {
      continue;
    }

    // Skip if line does not look like a pure assignment (contains `==` or similar comparisons in condition context)
    const m = assignRe.exec(line);
    if (!m) {
      continue;
    }
    const varName = m[1]!;
    const rhs = m[2]!;

    // Exclude cases where rhs starts with `=` (meaning `==` comparison) — already filtered by regex `=\s*(.+)` non-greedy
    // but `a == b` would match with varName='a' and rhs='= b'. Guard:
    if (rhs.startsWith("=")) {
      continue;
    }

    const lc = varName.toLowerCase();
    // Never shadow a param name as a local var — a param reference of itself stays a param
    if (paramsLc.has(lc)) {
      continue;
    }

    const binding = resolveExpression(rhs, env);

    if (seen.has(lc)) {
      const prev = assignedOnce.get(lc);
      if (prev && !bindingsEqual(prev, binding)) {
        // Konservativ: Multi-Assign mit unterschiedlichen Bindungen → dynamic.
        assignedOnce.set(lc, { kind: "dynamic" });
        env.vars.set(lc, { kind: "dynamic" });
      }
      // else: identische Bindung, Zustand bleibt
    } else {
      seen.add(lc);
      assignedOnce.set(lc, binding);
      env.vars.set(lc, binding);
    }
  }

  return env;
}

function bindingsEqual(a: VarBinding, b: VarBinding): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "literal" && b.kind === "literal") {
    return a.value === b.value;
  }
  if (a.kind === "param" && b.kind === "param") {
    return a.paramName.toLowerCase() === b.paramName.toLowerCase();
  }
  return a.kind === "dynamic";
}
