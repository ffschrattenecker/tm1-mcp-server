// Cube/dimension reference check for TI code: which object names does the code
// hand to well-known TI functions, and do they exist on the server?
//
// One core for two callers: tm1_validate_process_refs (the read-only
// validator) and the install tools' preflight (import_pro_file,
// import_process_from_git, install_pro_bundle, upsert_process), which run it
// on the EXACT payload they are about to install. Before this was shared, the
// preflight ran the syntax check only, so a deploy could validate cleanly and
// still install code that names a cube that does not exist.
//
// TM1 lets syntactically valid code reference non-existent objects — the
// compiler never resolves names — so this catches the gap between compile and
// runtime. It does NOT flag:
//   - existence probes (CubeExists, DimensionExists, HierarchyExists,
//     SubsetExists, ViewExists): asking whether an object exists is legitimate
//     precisely when it may not;
//   - names the same code creates (CubeCreate / DimensionCreate with a literal
//     or literal-bound name): the `IF(DimensionExists('X') = 0);
//     DimensionCreate('X');` pattern must pass.
import { buildProcessEnv, type ProcessEnv } from "./callgraph/variableEnv.js";

export const TABS = ["prolog", "metadata", "data", "epilog"] as const;
export type Tab = (typeof TABS)[number];
export type ProcessCode = Partial<Record<Tab, string>>;

export interface RefIssue {
  kind: "cube" | "dimension";
  name: string;
  tab: Tab;
  line: number;
  context: string;
}

export interface ProcessRefReport {
  cubeRefsScanned: number;
  dimensionRefsScanned: number;
  unresolved: number;
  issues: RefIssue[];
  /** Tabs that carried code and were scanned. */
  tabsChecked: Tab[];
  /**
   * Object-name arguments passed as identifiers that no literal binding
   * resolves (parameters, datasource variables, computed values). Those
   * references were not checked.
   */
  unresolvableArgs: number;
  /** True when unresolvableArgs > 0 — the report does not cover every reference. */
  partial: boolean;
}

/** What the check needs from the server: the object catalogue. */
export interface ObjectCatalogue {
  cubes: { list: () => Promise<Array<{ name: string }>> };
  dimensions: { list: () => Promise<Array<{ name: string }>> };
}

const CUBE_ARG1_FNS =
  "CellGetN|CellGetS|CellIsUpdateable|ViewCreate|ViewDestroy|ViewZeroOut|CubeClearData|SubsetCreatebyMDX|ViewSubsetAssign|DBR|DBS|DBSS|CubeProcessFeeders|CubeUnload|CubeLockOverride|CubeSetLogChanges";

const DIM_ARG1_FNS =
  "SubsetCreate|SubsetDestroy|DimensionElementInsertDirect|DimensionElementComponentAdd|DimensionElementDelete|DimensionElementPrincipalName|DimSiz|DimNm|DimIx|DType|ElementType|ElementLevel|ElementWeight|HierarchyName|AttrS|AttrN";

const CREATE_CUBE_FNS = "CubeCreate";
const CREATE_DIM_FNS = "DimensionCreate";

const litRe = (fns: string) =>
  new RegExp(`\\b(${fns})\\s*\\(\\s*'([^']+)'`, "gi");
// Arg-1 passed as a bare identifier (sCube = 'x'; CellGetN(sCube, ...)) —
// resolved through the per-process variable env; unresolvable identifiers
// (params, datasource vars, reassigned or computed values) are counted as
// unchecked.
const identRe = (fns: string) =>
  new RegExp(`\\b(${fns})\\s*\\(\\s*([A-Za-z_]\\w*)\\s*[,)]`, "gi");

const CUBE_FN_RE = litRe(CUBE_ARG1_FNS);
const DIM_FN_RE = litRe(DIM_ARG1_FNS);
const CUBE_FN_IDENT_RE = identRe(CUBE_ARG1_FNS);
const DIM_FN_IDENT_RE = identRe(DIM_ARG1_FNS);
const CUBE_CREATE_RE = litRe(CREATE_CUBE_FNS);
const DIM_CREATE_RE = litRe(CREATE_DIM_FNS);
const CUBE_CREATE_IDENT_RE = identRe(CREATE_CUBE_FNS);
const DIM_CREATE_IDENT_RE = identRe(CREATE_DIM_FNS);

// CellPutN/CellPutS/CellIncrementN/CellPutProportionalSpread take the value as
// arg 1 and the cube as arg 2; AttrPutS/AttrPutN/ElementSecurityPut take the
// dimension as arg 2. The value arg is an arbitrary expression (nested calls,
// '|'-concat, multi-line), so these are resolved with a paren/quote walker
// (secondArgText) instead of a regex skip.
const CUBE_ARG2_FN_RE =
  /\b(?:CellPutN|CellPutS|CellIncrementN|CellPutProportionalSpread)\s*\(/gi;

const DIM_ARG2_FN_RE = /\b(?:AttrPutS|AttrPutN|ElementSecurityPut)\s*\(/gi;

// Cap the argument walk so a pathological unterminated call cannot scan the
// whole remaining tab.
const ARG_SCAN_MAX_CHARS = 2000;

// Walk the argument list starting after `(` at openParen, tracking paren depth
// and TI string state ('' is the quote escape), and return the raw text of the
// second top-level argument. Newlines are ordinary whitespace, so multi-line
// calls resolve too; TI strings cannot span lines, so an open string is closed
// at end-of-line to resync.
function secondArgText(text: string, openParen: number): string | null {
  let depth = 0;
  let inStr = false;
  let argIndex = 0;
  let argStart = openParen + 1;
  const end = Math.min(text.length, openParen + 1 + ARG_SCAN_MAX_CHARS);
  for (let i = openParen + 1; i < end; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++;
          continue;
        }
        inStr = false;
      } else if (ch === "\n") {
        inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth === 0) {
        return argIndex === 1 ? text.slice(argStart, i) : null;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      if (argIndex === 1) return text.slice(argStart, i);
      argIndex++;
      argStart = i + 1;
    }
  }
  return null;
}

function quotedLiteral(argText: string): string | null {
  const m = /^\s*'((?:[^']|'')+)'\s*$/.exec(argText);
  return m ? m[1]!.replace(/''/g, "'") : null;
}

// Resolve a bare identifier through the process env: only a variable bound to
// exactly one string literal counts; params, datasource vars, and dynamic
// bindings return null (unresolvable at parse time).
function identLiteral(argText: string, env: ProcessEnv): string | null {
  const m = /^\s*([A-Za-z_]\w*)\s*$/.exec(argText);
  if (!m) return null;
  const binding = env.vars.get(m[1]!.toLowerCase());
  return binding?.kind === "literal" ? binding.value : null;
}

type Found = Map<string, { tab: Tab; line: number; context: string }>;

interface Scanner {
  unresolvable: number;
}

function scanCode(
  code: string,
  tab: Tab,
  regex: RegExp,
  into: Found,
  scanner: Scanner,
  resolveName?: (raw: string) => string | null,
): void {
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*#/.test(ln)) continue;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(ln)) !== null) {
      const name = resolveName ? resolveName(m[2]!) : m[2]!;
      if (!name) {
        scanner.unresolvable++;
        continue;
      }
      if (!into.has(name))
        into.set(name, { tab, line: i + 1, context: ln.trim().slice(0, 200) });
    }
  }
}

// Arg-2 variant of scanCode: matches the function name across the whole tab
// (comment lines blanked, so multi-line calls survive) and resolves the second
// argument with the paren/quote walker.
function scanArg2(
  code: string,
  tab: Tab,
  fnRe: RegExp,
  env: ProcessEnv,
  into: Found,
  scanner: Scanner,
): void {
  const lines = code.split(/\r?\n/).map((ln) => (/^\s*#/.test(ln) ? "" : ln));
  const text = lines.join("\n");
  fnRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    // The pattern ends with '(' — its index is the end of the match.
    const argText = secondArgText(text, m.index + m[0].length - 1);
    if (argText === null) continue;
    const name = quotedLiteral(argText) ?? identLiteral(argText, env);
    if (!name) {
      scanner.unresolvable++;
      continue;
    }
    if (into.has(name)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    into.set(name, {
      tab,
      line,
      context: lines[line - 1]!.trim().slice(0, 200),
    });
  }
}

/** Parse-time half: collect the references, no server round-trip. */
export function scanProcessRefs(code: ProcessCode): {
  cubeRefs: Found;
  dimRefs: Found;
  createdCubes: Set<string>;
  createdDims: Set<string>;
  tabsChecked: Tab[];
  unresolvableArgs: number;
} {
  // Variable env across all tabs in runtime order: a prolog assignment
  // like sCube = 'Sales'; makes CellGetN(sCube, ...) resolvable. Params
  // are unknown here (only code is scanned), so param-fed identifiers
  // stay unresolvable — conservative.
  const env = buildProcessEnv(TABS.map((t) => code[t] ?? "").join("\n"), []);
  const resolveIdent = (raw: string) => identLiteral(raw, env);
  const scanner: Scanner = { unresolvable: 0 };
  const cubeRefs: Found = new Map();
  const dimRefs: Found = new Map();
  const createdCubes: Found = new Map();
  const createdDims: Found = new Map();
  // Created names are collected with their own counter: an unresolvable
  // create name hides nothing, it just cannot excuse a reference.
  const ignore: Scanner = { unresolvable: 0 };
  const tabsChecked: Tab[] = [];
  for (const tab of TABS) {
    const c = code[tab];
    if (!c || c.trim() === "") continue;
    tabsChecked.push(tab);
    scanCode(c, tab, CUBE_FN_RE, cubeRefs, scanner);
    scanCode(c, tab, CUBE_FN_IDENT_RE, cubeRefs, scanner, resolveIdent);
    scanArg2(c, tab, CUBE_ARG2_FN_RE, env, cubeRefs, scanner);
    scanCode(c, tab, DIM_FN_RE, dimRefs, scanner);
    scanCode(c, tab, DIM_FN_IDENT_RE, dimRefs, scanner, resolveIdent);
    scanArg2(c, tab, DIM_ARG2_FN_RE, env, dimRefs, scanner);
    scanCode(c, tab, CUBE_CREATE_RE, createdCubes, ignore);
    scanCode(c, tab, CUBE_CREATE_IDENT_RE, createdCubes, ignore, resolveIdent);
    scanCode(c, tab, DIM_CREATE_RE, createdDims, ignore);
    scanCode(c, tab, DIM_CREATE_IDENT_RE, createdDims, ignore, resolveIdent);
  }
  const lower = (m: Found) =>
    new Set([...m.keys()].map((k) => k.toLowerCase()));
  return {
    cubeRefs,
    dimRefs,
    createdCubes: lower(createdCubes),
    createdDims: lower(createdDims),
    tabsChecked,
    unresolvableArgs: scanner.unresolvable,
  };
}

/** Scan the code and resolve every reference against the server's catalogue. */
export async function checkProcessRefs(
  catalogue: ObjectCatalogue,
  code: ProcessCode,
  opts: { includeControl?: boolean } = {},
): Promise<ProcessRefReport> {
  const includeControl = opts.includeControl ?? true;
  const scan = scanProcessRefs(code);
  const [cubes, dims] = await Promise.all([
    catalogue.cubes.list(),
    catalogue.dimensions.list(),
  ]);
  const known = (items: Array<{ name: string }>) =>
    new Set(
      items
        .filter((o) => includeControl || !o.name.startsWith("}"))
        .map((o) => o.name.toLowerCase()),
    );
  const cubeNames = known(cubes);
  const dimNames = known(dims);

  const issues: RefIssue[] = [];
  for (const [name, info] of scan.cubeRefs) {
    const k = name.toLowerCase();
    if (!cubeNames.has(k) && !scan.createdCubes.has(k))
      issues.push({ kind: "cube", name, ...info });
  }
  for (const [name, info] of scan.dimRefs) {
    const k = name.toLowerCase();
    if (!dimNames.has(k) && !scan.createdDims.has(k))
      issues.push({ kind: "dimension", name, ...info });
  }
  return {
    cubeRefsScanned: scan.cubeRefs.size,
    dimensionRefsScanned: scan.dimRefs.size,
    unresolved: issues.length,
    issues,
    tabsChecked: scan.tabsChecked,
    unresolvableArgs: scan.unresolvableArgs,
    partial: scan.unresolvableArgs > 0,
  };
}
