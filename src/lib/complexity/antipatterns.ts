/**
 * TI anti-pattern lint engine.
 *
 * Walks the parsed AST of each process tab and emits a flat list of findings —
 * a different shape from the metrics ranking in {@link ./process-metrics}, kept
 * separate on purpose (rule violations, not a score). The same engine is meant
 * to be reusable later from a single-process pre-commit lint entry point.
 */
import type { TiStatement } from "../callgraph/types.js";
import {
  parseTab,
  type ProcessCodeInput,
  type TiTab,
} from "./process-metrics.js";
import { walkStatements } from "./walk.js";
import { TI_VAR } from "../ti-identifier.js";
import { quotedLiteral } from "../ti-lex.js";
import { semanticFindings, trailingComments } from "../ti-lint/rules.js";
import { maskCodeLine } from "../mask-secrets.js";

type Severity = "error" | "warn" | "info";

export interface Finding {
  process: string;
  tab: TiTab;
  line: number;
  rule: string;
  severity: Severity;
  snippet: string;
  hint: string;
}

export interface LintOptions {
  /** Element-arg count at/above which CellGetN/S is flagged as perf-risky. */
  cellGetDimThreshold?: number | undefined;
}

const TABS: ReadonlyArray<TiTab> = ["prolog", "metadata", "data", "epilog"];

/**
 * Destructive ops that wipe data/objects. Unconditional use (no enclosing If)
 * is treated as an error — a guard expresses deliberate intent. Lowercased.
 */
const DESTRUCTIVE = new Set<string>([
  "cubecleardata",
  "dimensiondeleteallelements",
  "processdestroy",
]);

/**
 * A destructive op is by-design (not a bug) when the process is a dedicated
 * clear/init/reset/test proc — those exist to wipe data. Matching the name
 * downgrades destructive-unguarded from error to warn (still surfaced, not
 * silenced). Substring match on the lowercased process name.
 */
const CLEAR_PROC_TOKENS = [
  "init",
  "zeroout",
  "zero_out",
  "clear",
  "reset",
  "test",
  "wipe",
];

function isClearProc(name: string): boolean {
  const n = name.toLowerCase();
  return CLEAR_PROC_TOKENS.some((t) => n.includes(t));
}

/** Process-invocation calls; in a loop they recurse/serialize. Lowercased. */
const PROCESS_CALLS = new Set<string>(["executeprocess", "runprocess"]);

const DEFAULT_CELLGET_DIM_THRESHOLD = 12;

// ---- dead-assignment helpers ----

/** TI implicit / datasource variables — never flagged as dead assignments. */
const IMPLICIT_VARS = new Set<string>([
  "value_is_string",
  "nvalue",
  "svalue",
  "datasourcenamescript",
  "datasourceasciidelimiter",
  "datasourceasciiquotecharacter",
  "datasourceasciithousandseparator",
  "datasourceasciiheaderrecords",
  "datasourceasciiDecimalseparator",
  "datasourceasciidecimalseparator",
  "datasourceview",
  "datasourcecube",
  "datasourcedimension",
  "datasourcedimensionsubset",
  "datasourcetype",
  "datasourcenameforserver",
  "datasourcenameforserverisoctet",
]);

function isImplicitVar(name: string): boolean {
  const n = name.toLowerCase();
  if (IMPLICIT_VARS.has(n)) return true;
  // V1, V2, ..., Vn  (datasource column vars)
  if (/^v\d+$/.test(n)) return true;
  return false;
}

/** RHS functions whose capture is idiomatically a return-code — skip dead check on the LHS. */
const SIDE_EFFECT_RHS = new Set<string>([
  "executeprocess",
  "runprocess",
  "fileop",
  "executeview",
]);

function hasSideEffectRhs(expr: string): boolean {
  const lo = expr.toLowerCase();
  for (const fn of SIDE_EFFECT_RHS) {
    if (lo.includes(fn + "(")) return true;
  }
  return false;
}

// Lookarounds instead of \b: \b does not fire after a trailing `.`/`$`/`%`.
const IDENTIFIER_RE = new RegExp(`(?<![\\w.$%\`])(${TI_VAR})`, "g");
const EXPAND_VAR_RE = /%([A-Za-z_]\w*)%/g;

/** Extract all potential variable-read tokens from a raw TI expression/arg/condition string. */
function collectReads(text: string, out: Set<string>): void {
  // %varName% inside Expand calls
  for (const m of text.matchAll(EXPAND_VAR_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  // Strip string literals so identifiers inside them don't pollute the read-set
  const stripped = text.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of stripped.matchAll(IDENTIFIER_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
}

function collectReadsFromStmts(stmts: TiStatement[], out: Set<string>): void {
  for (const { stmt: s } of walkStatements(stmts)) {
    if (s.type === "assignment") {
      collectReads(s.expression, out);
    } else if (s.type === "if") {
      collectReads(s.condition, out);
      for (const c of s.elseIfClauses) collectReads(c.condition, out);
    } else if (s.type === "while") {
      collectReads(s.condition, out);
    } else if (s.type === "functionCall") {
      for (const arg of s.args) collectReads(arg, out);
    }
  }
}

interface DeadCandidate {
  variable: string;
  originalVar: string;
  tab: TiTab;
  line: number;
}

function collectDeadCandidates(
  stmts: TiStatement[],
  tab: TiTab,
  lineOrigin: number[],
  out: DeadCandidate[],
): void {
  for (const { stmt: s } of walkStatements(stmts)) {
    if (
      s.type === "assignment" &&
      !isImplicitVar(s.variable) &&
      !hasSideEffectRhs(s.expression)
    ) {
      out.push({
        variable: s.variable.toLowerCase(),
        originalVar: s.variable,
        tab,
        line: sourceLine(lineOrigin, s.line),
      });
    }
  }
}

/** UNC (`\\srv\…`) or drive-letter (`C:\…`) absolute path. */
const PATH_LITERAL = /^(?:\\\\|[A-Za-z]:[\\/])/;

/** Maps a 1-based line of a normalized tab back to the line the author wrote. */
function sourceLine(lineOrigin: number[], line: number): number {
  return lineOrigin[line - 1] ?? line;
}

interface WalkCtx {
  process: string;
  tab: TiTab;
  cellGetDimThreshold: number;
  /** True when the process name marks it a clear/init/reset proc (demotes destructive). */
  clearProc: boolean;
  lineOrigin: number[];
  findings: Finding[];
}

function walk(stmts: TiStatement[], ctx: WalkCtx): void {
  for (const { stmt: s, loopDepth, ifDepth } of walkStatements(stmts)) {
    const line = sourceLine(ctx.lineOrigin, s.line);
    if (s.type === "assignment") {
      const cg = s.cellGetInfo;
      if (cg) {
        // params[0] is the cube; remaining args are one element ref per
        // dimension, so dimCount = params.length - 1.
        const dimCount = Math.max(cg.params.length - 1, 0);
        if (dimCount >= ctx.cellGetDimThreshold) {
          const inLoop = loopDepth > 0;
          ctx.findings.push({
            process: ctx.process,
            tab: ctx.tab,
            line,
            rule: "cellget-perf",
            severity: inLoop ? "warn" : "info",
            snippet: `${s.variable} = ${cg.fn}(${cg.params.join(", ")})`,
            hint:
              `${cg.fn} on a ${dimCount}-dimension cube` +
              (inLoop ? ` inside a loop (depth ${loopDepth})` : "") +
              ` can be a perf hot path on large cubes — worse when many consolidated (C) elements are addressed (not statically detectable here). Consider an MDX/view read or caching.`,
          });
        }
      }
    } else if (s.type === "functionCall") {
      const name = s.name.toLowerCase();
      const snippet = `${s.name}(${s.args.join(", ")})`;
      if (ifDepth === 0 && DESTRUCTIVE.has(name)) {
        ctx.findings.push({
          process: ctx.process,
          tab: ctx.tab,
          line,
          rule: "destructive-unguarded",
          severity: ctx.clearProc ? "warn" : "error",
          snippet,
          hint: ctx.clearProc
            ? `${s.name} wipes data/objects unconditionally. The process name marks it a clear/init proc, so this is likely by-design — confirm it can only target the intended cube.`
            : `${s.name} wipes data/objects unconditionally — wrap in an If guard so it cannot run by accident.`,
        });
      }
      if (loopDepth > 0 && PROCESS_CALLS.has(name)) {
        const isAsync = name === "runprocess";
        ctx.findings.push({
          process: ctx.process,
          tab: ctx.tab,
          line,
          rule: "exec-in-loop",
          severity: "warn",
          snippet,
          hint: isAsync
            ? `RunProcess in a loop runs async — you lose control over timing and persistence (when each child commits). Prefer a single child that loops internally.`
            : `ExecuteProcess in a loop runs sync per iteration — adds compounding complexity and overhead. Consider pushing the loop into the child.`,
        });
      }
      for (const arg of s.args) {
        const val = quotedLiteral(arg);
        if (val && PATH_LITERAL.test(val)) {
          ctx.findings.push({
            process: ctx.process,
            tab: ctx.tab,
            line,
            rule: "hardcoded-path",
            severity: "warn",
            snippet: `${s.name}(… ${arg} …)`,
            hint: `Hardcoded path '${val}' in ${s.name} — move it to a process parameter or a config cube so it survives environment moves.`,
          });
        }
      }
    }
  }
}

export function lintProcess(
  process: string,
  code: ProcessCodeInput,
  opts?: LintOptions,
): Finding[] {
  return lintReport(process, code, opts).findings;
}

export interface LintReport {
  findings: Finding[];
  /** Non-empty tabs the parser rejected: only the raw-text rules saw them. */
  unparsedTabs: TiTab[];
}

export function lintReport(
  process: string,
  code: ProcessCodeInput,
  opts?: LintOptions,
): LintReport {
  const cellGetDimThreshold =
    opts?.cellGetDimThreshold ?? DEFAULT_CELLGET_DIM_THRESHOLD;
  const clearProc = isClearProc(process);
  const findings: Finding[] = [];

  // Parse all tabs once; reuse for both walk and dead-assignment passes.
  const parsedTabs = new Map<TiTab, NonNullable<ReturnType<typeof parseTab>>>();
  const unparsedTabs: TiTab[] = [];
  for (const tab of TABS) {
    const src = code[tab] ?? "";
    if (src.trim() === "") continue;
    findings.push(...trailingComments(process, tab, src));
    const parsed = parseTab(src);
    if (parsed) parsedTabs.set(tab, parsed);
    else unparsedTabs.push(tab);
  }

  // Existing per-tab rules
  for (const [tab, { ast, lineOrigin }] of parsedTabs) {
    walk(ast, {
      process,
      tab,
      cellGetDimThreshold,
      clearProc,
      lineOrigin,
      findings,
    });
    findings.push(
      ...semanticFindings(ast, {
        process,
        tab,
        line: (n) => sourceLine(lineOrigin, n),
      }),
    );
  }

  // dead-assignment: two-pass over all parsed tabs
  const readSet = new Set<string>();
  for (const { ast } of parsedTabs.values()) {
    collectReadsFromStmts(ast, readSet);
  }

  const deadCandidates: DeadCandidate[] = [];
  for (const tab of ["metadata", "data"] as const) {
    const parsed = parsedTabs.get(tab);
    if (parsed) {
      collectDeadCandidates(parsed.ast, tab, parsed.lineOrigin, deadCandidates);
    }
  }

  const reported = new Set<string>();
  for (const c of deadCandidates) {
    if (reported.has(c.variable)) continue;
    if (!readSet.has(c.variable)) {
      reported.add(c.variable);
      findings.push({
        process,
        tab: c.tab,
        line: c.line,
        rule: "dead-assignment",
        severity: "info",
        snippet: `${c.originalVar} = ...`,
        hint: `'${c.originalVar}' is assigned in the ${c.tab} tab but never read — remove or use it.`,
      });
    }
  }

  // Snippets quote code, and code can hold a credential literal.
  for (const f of findings) f.snippet = maskCodeLine(f.snippet);
  return { findings, unparsedTabs };
}
