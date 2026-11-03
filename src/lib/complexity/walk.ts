/**
 * Shared traversal of a parsed TI statement tree for the complexity linter.
 */
import type { TiStatement } from "../callgraph/types.js";

export interface StatementVisit {
  stmt: TiStatement;
  /** Number of enclosing while loops. */
  loopDepth: number;
  /** Number of enclosing if / elseif / else bodies. */
  ifDepth: number;
}

/**
 * Yields every statement in pre-order, descending into if/elseif/else and
 * while bodies. A statement is yielded before its children, and bodies are
 * visited in source order (then, each elseif, else).
 */
export function* walkStatements(
  stmts: TiStatement[],
  loopDepth = 0,
  ifDepth = 0,
): Generator<StatementVisit> {
  for (const stmt of stmts) {
    yield { stmt, loopDepth, ifDepth };
    if (stmt.type === "if") {
      yield* walkStatements(stmt.thenBody, loopDepth, ifDepth + 1);
      for (const c of stmt.elseIfClauses) {
        yield* walkStatements(c.body, loopDepth, ifDepth + 1);
      }
      yield* walkStatements(stmt.elseBody, loopDepth, ifDepth + 1);
    } else if (stmt.type === "while") {
      yield* walkStatements(stmt.body, loopDepth + 1, ifDepth);
    }
  }
}
