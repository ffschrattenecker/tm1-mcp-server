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
//
// Element literals are checked too, in the cell functions (CellGetN/S,
// CellPutN/S, CellIncrementN, CellIsUpdateable, CellPutProportionalSpread) of
// a cube that exists: each literal (or literal-bound) element argument is
// looked up in the dimension at its position. Why: a TI cell call with an
// element that does not exist does not abort the process — verified on
// 11.8.03500, it ends HasMinorErrors, the rest of the process runs, and the
// value is simply not written. Rules that keep this free of false positives:
//   - the lookup is TM1's own name resolution (case/space-insensitive,
//     aliases accepted), not a string compare;
//   - TI never passes the Sandboxes dimension (verified: a cell call that
//     included it failed), so positions map onto the cube's other dimensions;
//   - a call whose argument count does not match is skipped, not guessed at;
//   - elements the same code inserts are excused, and a dimension the code
//     inserts into with a computed name excuses every literal in it;
//   - variables (datasource fields, parameters) are not checked — that is
//     what the element is in most data-tab calls — and do not make the report
//     partial.
// Existence probes (DimIx, ElementIndex) are deliberately not element checks.
import { buildProcessEnv, type ProcessEnv } from "./callgraph/variableEnv.js";
import { mapSettledWithConcurrency } from "./concurrency.js";

export const TABS = ["prolog", "metadata", "data", "epilog"] as const;
export type Tab = (typeof TABS)[number];
export type ProcessCode = Partial<Record<Tab, string>>;

export interface RefIssue {
  kind: "cube" | "dimension" | "element";
  name: string;
  /** For kind "element": the dimension it was looked up in. */
  dimension?: string;
  tab: Tab;
  line: number;
  context: string;
}

export interface ProcessRefReport {
  cubeRefsScanned: number;
  dimensionRefsScanned: number;
  /** Distinct literal (dimension, element) pairs looked up. */
  elementRefsScanned: number;
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
  cubes: {
    list: () => Promise<Array<{ name: string }>>;
    /** Needed for the element check; without it elements are not checked. */
    getDimensionNames?: (cubeName: string) => Promise<string[]>;
  };
  dimensions: { list: () => Promise<Array<{ name: string }>> };
  elements?: {
    exists: (dim: string, hierarchy: string, el: string) => Promise<boolean>;
  };
}

// Distinct element lookups per report. Past it, the remaining literals are
// counted as unchecked (partial) rather than turning one validation into
// hundreds of requests.
const ELEMENT_LOOKUP_MAX = 200;
const SANDBOX_DIMENSION = "sandboxes";

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
// and TI string state ('' is the quote escape), and return the raw text of
// every top-level argument, or null for an unterminated call. Newlines are
// ordinary whitespace, so multi-line calls resolve too; TI strings cannot span
// lines, so an open string is closed at end-of-line to resync.
function callArgs(text: string, openParen: number): string[] | null {
  let depth = 0;
  let inStr = false;
  const args: string[] = [];
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
        args.push(text.slice(argStart, i));
        return args;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(text.slice(argStart, i));
      argStart = i + 1;
    }
  }
  return null;
}

function secondArgText(text: string, openParen: number): string | null {
  return callArgs(text, openParen)?.[1] ?? null;
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

// Cell functions and the position of their cube argument; the element
// arguments follow it, one per (non-Sandboxes) cube dimension.
const CELL_FN_RE =
  /\b(CellGetN|CellGetS|CellIsUpdateable|CellPutN|CellPutS|CellIncrementN|CellPutProportionalSpread)\s*\(/gi;
const CELL_CUBE_ARG: Record<string, number> = {
  cellgetn: 0,
  cellgets: 0,
  cellisupdateable: 0,
  cellputn: 1,
  cellputs: 1,
  cellincrementn: 1,
  cellputproportionalspread: 1,
};

// Element inserts: [dimension arg, element arg].
const INSERT_FN_RE =
  /\b(DimensionElementInsert|DimensionElementInsertDirect|HierarchyElementInsert)\s*\(/gi;
const INSERT_ARGS: Record<string, [number, number]> = {
  dimensionelementinsert: [0, 2],
  dimensionelementinsertdirect: [0, 2],
  hierarchyelementinsert: [0, 3],
};

/** TM1 compares names ignoring case and spaces. */
export const tm1Key = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, "");

interface CellCall {
  cube: string;
  /** One entry per element argument: the literal, or null if not literal. */
  elements: Array<string | null>;
  tab: Tab;
  line: number;
  context: string;
}

interface Inserts {
  /** tm1Key(dimension) → tm1Key(element) the code inserts. */
  literal: Map<string, Set<string>>;
  /** Dimensions the code inserts a computed element name into. */
  dynamicDims: Set<string>;
  /** True if some insert targets a dimension whose name is computed. */
  dynamicAnyDim: boolean;
}

function forEachCall(
  code: string,
  fnRe: RegExp,
  fn: (name: string, args: string[], line: number, context: string) => void,
): void {
  const lines = code.split(/\r?\n/).map((ln) => (/^\s*#/.test(ln) ? "" : ln));
  const text = lines.join("\n");
  fnRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    const args = callArgs(text, m.index + m[0].length - 1);
    if (args === null) continue;
    const line = text.slice(0, m.index).split("\n").length;
    fn(m[1]!.toLowerCase(), args, line, lines[line - 1]!.trim().slice(0, 200));
  }
}

function scanCellCalls(
  code: string,
  tab: Tab,
  env: ProcessEnv,
  into: CellCall[],
): void {
  forEachCall(code, CELL_FN_RE, (fn, args, line, context) => {
    const cubeIdx = CELL_CUBE_ARG[fn]!;
    const cubeArg = args[cubeIdx];
    if (cubeArg === undefined) return;
    const cube = quotedLiteral(cubeArg) ?? identLiteral(cubeArg, env);
    // An unresolvable cube is already counted by the cube scan.
    if (!cube) return;
    into.push({
      cube,
      elements: args
        .slice(cubeIdx + 1)
        .map((a) => quotedLiteral(a) ?? identLiteral(a, env)),
      tab,
      line,
      context,
    });
  });
}

function scanInserts(code: string, env: ProcessEnv, into: Inserts): void {
  forEachCall(code, INSERT_FN_RE, (fn, args) => {
    const [dimIdx, elIdx] = INSERT_ARGS[fn]!;
    const dimArg = args[dimIdx];
    const elArg = args[elIdx];
    if (dimArg === undefined || elArg === undefined) return;
    const dim = quotedLiteral(dimArg) ?? identLiteral(dimArg, env);
    if (!dim) {
      into.dynamicAnyDim = true;
      return;
    }
    const el = quotedLiteral(elArg) ?? identLiteral(elArg, env);
    const k = tm1Key(dim);
    if (!el) {
      into.dynamicDims.add(k);
      return;
    }
    if (!into.literal.has(k)) into.literal.set(k, new Set());
    into.literal.get(k)!.add(tm1Key(el));
  });
}

/** Parse-time half: collect the references, no server round-trip. */
export function scanProcessRefs(code: ProcessCode): {
  cubeRefs: Found;
  dimRefs: Found;
  createdCubes: Set<string>;
  createdDims: Set<string>;
  tabsChecked: Tab[];
  unresolvableArgs: number;
  cellCalls: CellCall[];
  inserts: Inserts;
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
  const cellCalls: CellCall[] = [];
  const inserts: Inserts = {
    literal: new Map(),
    dynamicDims: new Set(),
    dynamicAnyDim: false,
  };
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
    scanCellCalls(c, tab, env, cellCalls);
    scanInserts(c, env, inserts);
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
    cellCalls,
    inserts,
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
  const elementCheck = await checkElementRefs(catalogue, scan, cubeNames);
  issues.push(...elementCheck.issues);
  const unresolvableArgs = scan.unresolvableArgs + elementCheck.overflow;
  return {
    cubeRefsScanned: scan.cubeRefs.size,
    dimensionRefsScanned: scan.dimRefs.size,
    elementRefsScanned: elementCheck.scanned,
    unresolved: issues.length,
    issues,
    tabsChecked: scan.tabsChecked,
    unresolvableArgs,
    partial: unresolvableArgs > 0,
  };
}

async function checkElementRefs(
  catalogue: ObjectCatalogue,
  scan: ReturnType<typeof scanProcessRefs>,
  cubeNames: Set<string>,
): Promise<{ issues: RefIssue[]; scanned: number; overflow: number }> {
  // Called as methods: the real catalogue is TM1Client, whose services use
  // `this`, so detaching them would lose it.
  const cubesSvc = catalogue.cubes;
  const elements = catalogue.elements;
  if (!cubesSvc.getDimensionNames || !elements || scan.inserts.dynamicAnyDim) {
    return { issues: [], scanned: 0, overflow: 0 };
  }

  // Only cubes that exist and that the code does not create: a missing cube
  // is already an issue, and a created one has no dimensions to ask about.
  const cubes = [
    ...new Set(
      scan.cellCalls
        .map((c) => c.cube)
        .filter(
          (c) =>
            cubeNames.has(c.toLowerCase()) &&
            !scan.createdCubes.has(c.toLowerCase()),
        ),
    ),
  ];
  const dimsOf = new Map<string, string[]>();
  await Promise.all(
    cubes.map(async (c) => {
      const all = await cubesSvc.getDimensionNames!(c);
      // TI's cell functions never take the Sandboxes dimension.
      dimsOf.set(
        c.toLowerCase(),
        all.filter((d) => d.toLowerCase() !== SANDBOX_DIMENSION),
      );
    }),
  );

  // Distinct (dimension, element) pairs, first occurrence kept for the report.
  const pending = new Map<
    string,
    { dim: string; el: string; call: CellCall }
  >();
  for (const call of scan.cellCalls) {
    const dims = dimsOf.get(call.cube.toLowerCase());
    if (!dims || dims.length !== call.elements.length) continue;
    call.elements.forEach((el, i) => {
      if (el === null) return;
      const dim = dims[i]!;
      const dk = tm1Key(dim);
      if (scan.inserts.dynamicDims.has(dk)) return;
      if (scan.inserts.literal.get(dk)?.has(tm1Key(el))) return;
      const key = `${dk}\u0000${tm1Key(el)}`;
      if (!pending.has(key)) pending.set(key, { dim, el, call });
    });
  }

  const todo = [...pending.values()];
  const checked = todo.slice(0, ELEMENT_LOOKUP_MAX);
  const settled = await mapSettledWithConcurrency(checked, 8, ({ dim, el }) =>
    resolvesInTi(elements, dim, el),
  );
  // A lookup that failed for any reason other than "not found" (auth,
  // transport, denial) must surface, not read as a missing element.
  const found = settled.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
  const issues: RefIssue[] = [];
  checked.forEach(({ dim, el, call }, i) => {
    if (!found[i])
      issues.push({
        kind: "element",
        name: el,
        dimension: dim,
        tab: call.tab,
        line: call.line,
        context: call.context,
      });
  });
  return {
    issues,
    scanned: checked.length,
    overflow: todo.length - checked.length,
  };
}

// TI addresses an alternate hierarchy as 'Hierarchy:Element'. A colon can also
// be part of a plain element name, so both readings are tried.
async function resolvesInTi(
  elements: NonNullable<ObjectCatalogue["elements"]>,
  dim: string,
  el: string,
): Promise<boolean> {
  const colon = el.indexOf(":");
  if (colon > 0) {
    const hier = el.slice(0, colon);
    const member = el.slice(colon + 1);
    try {
      if (await elements.exists(dim, hier, member)) return true;
    } catch {
      // Not a hierarchy of this dimension — fall through to the plain name.
    }
  }
  return elements.exists(dim, dim, el);
}
