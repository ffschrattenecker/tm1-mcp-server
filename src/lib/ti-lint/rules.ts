/**
 * Semantic TI rules: code that compiles but does not run the way it reads.
 * Rule ideas from deutschebahn/linti (Apache-2.0), reimplemented on this
 * server's parser. Each finding is a TI fact, not a naming or style preference.
 */
import type { TiStatement } from "../callgraph/types.js";
import type { Finding } from "../complexity/antipatterns.js";
import type { TiTab } from "../complexity/process-metrics.js";
import { walkStatements } from "../complexity/walk.js";
import { quotedLiteral } from "../ti-lex.js";
import { FUNCTION_SECTIONS } from "./function-sections.js";

interface Ctx {
  process: string;
  tab: TiTab;
  /** Maps a parsed-text line back to the line the author wrote. */
  line: (parsedLine: number) => number;
  findings: Finding[];
}

function push(ctx: Ctx, f: Omit<Finding, "process" | "tab">): void {
  ctx.findings.push({ process: ctx.process, tab: ctx.tab, ...f });
}

function callSnippet(s: { name: string; args: string[] }): string {
  return s.args.length ? `${s.name}(${s.args.join(", ")})` : s.name;
}

// ---- section-placement ----

function sectionPlacement(ast: TiStatement[], ctx: Ctx): void {
  for (const { stmt: s, ifDepth } of walkStatements(ast)) {
    if (s.type !== "functionCall") continue;
    const p = FUNCTION_SECTIONS.get(s.name.toLowerCase());
    if (!p || !p.badIn.includes(ctx.tab)) continue;
    const perRecordTab = ctx.tab === "metadata" || ctx.tab === "data";
    if (p.perRecord && perRecordTab && ifDepth > 0) continue;
    push(ctx, {
      line: ctx.line(s.line),
      rule: "section-placement",
      severity: p.severity,
      snippet: callSnippet(s),
      hint: `${s.name} in the ${ctx.tab} tab: it ${p.reason}`,
    });
  }
}

// ---- unreachable-code ----

/** Statements after which nothing else in the same block runs. Lowercased. */
const TERMINATORS = new Set([
  "processquit",
  "processerror",
  "processbreak",
  "processabort",
  "itemskip",
  "itemreject",
]);

function unreachable(stmts: TiStatement[], ctx: Ctx): void {
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    if (s.type === "if") {
      unreachable(s.thenBody, ctx);
      for (const c of s.elseIfClauses) unreachable(c.body, ctx);
      unreachable(s.elseBody, ctx);
    } else if (s.type === "while") {
      unreachable(s.body, ctx);
    } else if (
      s.type === "functionCall" &&
      TERMINATORS.has(s.name.toLowerCase()) &&
      i + 1 < stmts.length
    ) {
      push(ctx, {
        line: ctx.line(stmts[i + 1]!.line),
        rule: "unreachable-code",
        severity: "warn",
        snippet: callSnippet(s),
        hint: `Code after ${s.name} in the same block never runs. Remove it, or put it before ${s.name}.`,
      });
      return;
    }
  }
}

// ---- datasource-after-prolog ----

// The ASCII delimiter/quote/separator variables are absent on purpose: they
// also format ASCIIOutput/TextOutput, so setting them later is an idiom.
const DATASOURCE_VARS = new Set([
  "datasourcetype",
  "datasourcenameforserver",
  "datasourcenameforclient",
  "datasourceasciiheaderrecords",
  "datasourcecubeview",
  "datasourcedimensionsubset",
  "datasourcequery",
  "datasourceusername",
  "datasourcepassword",
]);

function datasourceAfterProlog(ast: TiStatement[], ctx: Ctx): void {
  if (ctx.tab === "prolog") return;
  for (const { stmt: s } of walkStatements(ast)) {
    if (s.type !== "assignment") continue;
    if (!DATASOURCE_VARS.has(s.variable.toLowerCase())) continue;
    push(ctx, {
      line: ctx.line(s.line),
      rule: "datasource-after-prolog",
      severity: "warn",
      snippet: `${s.variable} = ${s.expression}`,
      hint: `TM1 opens the datasource when the Prolog ends, so setting ${s.variable} in the ${ctx.tab} tab does not change what this run reads. Set it in the Prolog.`,
    });
  }
}

// ---- hardcoded-credential ----

/** Function → index of its password argument. Lowercased. */
const PASSWORD_ARG = new Map([
  ["odbcopen", 2],
  ["odbcopenex", 2],
]);

// Narrower than mask-secrets' isSecretName (no `auth`, `key`): a wrong mask
// costs nothing, a wrong warning teaches the reader to skip the list.
const SECRET_NAME = /pass(word|wd)?|pwd|secret|token|api_?key|credential/i;

function hardcodedSecret(ast: TiStatement[], ctx: Ctx): void {
  for (const { stmt: s } of walkStatements(ast)) {
    if (s.type === "functionCall") {
      const idx = PASSWORD_ARG.get(s.name.toLowerCase());
      const arg = idx === undefined ? undefined : s.args[idx];
      if (arg !== undefined && quotedLiteral(arg)) {
        push(ctx, {
          line: ctx.line(s.line),
          rule: "hardcoded-credential",
          severity: "warn",
          snippet: `${s.name}(…, '***')`,
          hint: `${s.name} gets its password as a literal, so the credential is stored in the process code and in every export. Read it from a parameter or a secured cube instead.`,
        });
      }
    } else if (
      s.type === "assignment" &&
      SECRET_NAME.test(s.variable) &&
      quotedLiteral(s.expression.trim())
    ) {
      push(ctx, {
        line: ctx.line(s.line),
        rule: "hardcoded-credential",
        severity: "warn",
        snippet: `${s.variable} = '***'`,
        hint: `'${s.variable}' is set from a literal, so the credential is stored in the process code and in every export. Read it from a parameter or a secured cube instead.`,
      });
    }
  }
}

// ---- trailing-comment ----

/**
 * Column of a `#` that follows code on the same line, or -1. TI comments must
 * start the line: `x = 1; # note` does not compile, and the compiler's message
 * (`Syntax error on or before …`) does not say why.
 */
function trailingCommentAt(line: string): number {
  if (line.trimStart().startsWith("#")) return -1;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      if (inString && line[i + 1] === "'") i++;
      else inString = !inString;
    } else if (c === "#" && !inString) {
      return i;
    }
  }
  return -1;
}

/** Runs on the raw text, so it also covers a tab the parser rejects. */
export function trailingComments(
  process: string,
  tab: TiTab,
  src: string,
): Finding[] {
  const out: Finding[] = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const col = trailingCommentAt(text);
    if (col < 0) return;
    out.push({
      process,
      tab,
      line: i + 1,
      rule: "trailing-comment",
      severity: "error",
      snippet: text.trim(),
      hint: "TI comments must start the line; a # after code is a syntax error. Move the comment to its own line.",
    });
  });
  return out;
}

/** All AST-based semantic rules for one parsed tab. */
export function semanticFindings(
  ast: TiStatement[],
  ctx: Omit<Ctx, "findings">,
): Finding[] {
  const c: Ctx = { ...ctx, findings: [] };
  sectionPlacement(ast, c);
  unreachable(ast, c);
  datasourceAfterProlog(ast, c);
  hardcodedSecret(ast, c);
  return c.findings;
}
