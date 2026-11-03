// Cube/dimension reference check for TI code: which object names does the code
// hand to well-known TI functions, and do they exist on the server?
//
// One core for two callers: tm1_validate_process_refs (the read-only
// validator) and the install tools' preflight (import_pro_file,
// import_process_from_git, install_pro_bundle, upsert_process), which run it
// on the EXACT payload they are about to install, so a deploy cannot validate
// cleanly and still install code that names a cube that does not exist.
//
// Argument positions come from TI_ARG_IDX (the callgraph's signature table).
// TM1 lets syntactically valid code reference non-existent objects — the
// compiler never resolves names — so this catches the gap between compile and
// runtime. It does NOT flag:
//   - existence probes (CubeExists, DimensionExists, HierarchyExists,
//     SubsetExists, ViewExists, ElementExists, ...): asking whether an object
//     exists is legitimate precisely when it may not;
//   - the object a destroy or unload removes (CubeDestroy, DimensionDestroy,
//     CubeUnload, ...): guarded cleanup is legitimate when it may be absent;
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
//   - a call whose element count does not match the cube is not looked up:
//     it is an issue of its own (kind "elementCount"). TM1 compiles it, and
//     at run time the process aborts with "Wrong Number of Dimension
//     Elements" (verified on 11.8.03500);
//   - elements the same code inserts are excused, and a dimension the code
//     inserts into with a computed name excuses every literal in it;
//   - variables (datasource fields, parameters) are not checked — that is
//     what the element is in most data-tab calls — and do not make the report
//     partial.
// ElementIndex is an existence probe, so it is not an element check either.
//
// One more element trap needs no server: DimensionElementInsert and
// HierarchyElementInsert commit only when the Prolog/Metadata tab ends, so an
// AttrPut*/ElementAttrPut* on that element later in the same tab fails with
// "Element not found" on the run that creates it (11.8.03500). Kind
// "uncommittedElement"; *Direct inserts are not flagged.
import { isControlName } from "./control-name.js";
import { buildProcessEnv, type ProcessEnv } from "./callgraph/variableEnv.js";
import { TI_ARG_IDX } from "./callgraph/tiArgIndex.js";
import { mapSettledWithConcurrency } from "./concurrency.js";
import { callArgs, quotedLiteral, truncateSnippet } from "./ti-lex.js";
import { tm1NameKey, withoutSandboxes } from "./tm1-name.js";

const TABS = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof TABS)[number];
export type ProcessCode = Partial<Record<Tab, string>>;

export interface RefIssue {
  kind:
    "cube" | "dimension" | "element" | "elementCount" | "uncommittedElement";
  /** The object named; for kind "elementCount" the cube. */
  name: string;
  /** For kinds "element" and "uncommittedElement": the element's dimension. */
  dimension?: string;
  /** For kind "elementCount": elements the cube takes (Sandboxes excluded). */
  expected?: number;
  /** For kind "elementCount": elements the call passes. */
  got?: number;
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

// Functions whose object-name argument may legitimately not exist: existence
// probes, and destroys/unloads of the object named (the guarded cleanup
// `IF(CubeExists('X') = 1); CubeDestroy('X'); ENDIF;` must pass). The
// argument is not checked. HierarchyDestroy is excused too, though its checked
// argument is the dimension. Destroys whose checked argument is the parent
// (ViewDestroy, SubsetDestroy, RuleDestroy) are still checked.
const UNCHECKED_FNS: ReadonlySet<string> = new Set([
  "cubeexists",
  "viewexists",
  "dimensionexists",
  "hierarchyexists",
  "subsetexists",
  "attributeexists",
  "cellexists",
  "elementexists",
  "elementindex",
  "dimensionelementexists",
  "hierarchyelementexists",
  "hierarchysubsetexists",
  "hierarchysubsetelementexists",
  "subsetelementexists",
  "cubedestroy",
  "cubedelete",
  "cubeunload",
  "dimensiondestroy",
  "hierarchydestroy",
]);

// Creates whose literal name excuses a later reference to it in the same code.
const CREATE_FNS: ReadonlySet<string> = new Set([
  "cubecreate",
  "dimensioncreate",
]);

// Cell functions: the cube is at TI_ARG_IDX.cube, the elements follow it.
const CELL_FNS: ReadonlySet<string> = new Set([
  "cellgetn",
  "cellgets",
  "cellisupdateable",
  "cellputn",
  "cellputs",
  "cellincrementn",
  "cellputproportionalspread",
]);

// Element inserts: the dimension is at TI_ARG_IDX.dimension, the element at
// TI_ARG_IDX.element.
const INSERT_FNS: ReadonlySet<string> = new Set([
  "dimensionelementinsert",
  "dimensionelementinsertdirect",
  "hierarchyelementinsert",
]);

// Inserts that commit only when the tab ends (not the *Direct variants), and
// the attribute writes that fail on such an element in the same tab.
const QUEUED_INSERT_FNS: ReadonlySet<string> = new Set([
  "dimensionelementinsert",
  "hierarchyelementinsert",
]);
const ATTR_PUT_FNS: ReadonlySet<string> = new Set([
  "attrputs",
  "attrputn",
  "elementattrputs",
  "elementattrputn",
]);
const ELEMENT_ATTR_PUT_FNS: ReadonlySet<string> = new Set([
  "elementattrputs",
  "elementattrputn",
]);
const QUEUED_INSERT_TABS: ReadonlySet<Tab> = new Set(["prolog", "metadata"]);

type Found = Map<string, { tab: Tab; line: number; context: string }>;

interface CellCall {
  cube: string;
  /** One entry per element argument: the literal, or null if not literal. */
  elements: Array<string | null>;
  tab: Tab;
  line: number;
  context: string;
}

interface Inserts {
  /** tm1NameKey(dimension) → tm1NameKey(element) the code inserts. */
  literal: Map<string, Set<string>>;
  /** Dimensions the code inserts a computed element name into. */
  dynamicDims: Set<string>;
  /** True if some insert targets a dimension whose name is computed. */
  dynamicAnyDim: boolean;
}

interface Call {
  fn: string;
  args: string[];
  line: number;
  context: string;
  offset: number;
}

const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;

function forEachCall(
  code: string,
  fnRe: RegExp,
  fn: (
    name: string,
    args: string[],
    line: number,
    context: string,
    offset: number,
  ) => void,
): void {
  const lines = code.split(/\r?\n/).map((ln) => (/^\s*#/.test(ln) ? "" : ln));
  const text = lines.join("\n");
  fnRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    const args = callArgs(text, m.index + m[0].length - 1);
    if (args === null) continue;
    const line = text.slice(0, m.index).split("\n").length;
    fn(
      m[1]!.toLowerCase(),
      args,
      line,
      truncateSnippet(lines[line - 1]!, 200),
      m.index,
    );
  }
}

/** The 0-based position of a parameter in a TI_ARG_IDX table, if the function has one. */
function argIndex(
  table: Readonly<Record<string, number>>,
  fn: string,
): number | undefined {
  return Object.hasOwn(table, fn) ? table[fn] : undefined;
}

function argAt(args: string[], idx: number | undefined): string | undefined {
  return idx === undefined ? undefined : args[idx];
}

// The element position of an AttrPut / ElementAttrPut call. ElementAttrPut*
// takes the hierarchy before the element only in the five-argument form
// (dimension, hierarchy, element, attribute); the four-argument form has no
// hierarchy, so the element is one place earlier.
function attrElementIndex(fn: string, args: string[]): number | undefined {
  const idx = argIndex(TI_ARG_IDX.element, fn);
  if (idx === undefined) return undefined;
  return ELEMENT_ATTR_PUT_FNS.has(fn) && args.length === 4 ? idx - 1 : idx;
}

// Variable env: only a variable bound to exactly one string literal counts;
// params, datasource vars, and dynamic bindings return null (unresolvable at
// parse time).
function identLiteral(argText: string, env: ProcessEnv): string | null {
  const m = /^\s*([A-Za-z_]\w*)\s*$/.exec(argText);
  if (!m) return null;
  const binding = env.vars.get(m[1]!.toLowerCase());
  return binding?.kind === "literal" ? binding.value : null;
}

/** An argument as a name: a quoted literal, or a variable bound to one. */
function nameOf(argText: string, env: ProcessEnv): string | null {
  return quotedLiteral(argText) ?? identLiteral(argText, env);
}

interface ScanState {
  cubeRefs: Found;
  dimRefs: Found;
  /** tm1NameKey of each cube / dimension the code creates. */
  createdCubes: Set<string>;
  createdDims: Set<string>;
  cellCalls: CellCall[];
  inserts: Inserts;
  /** Object-name arguments that no literal binding resolves. */
  unresolvable: number;
}

/** One call's object-name references, cell calls and inserts. */
function scanCall(call: Call, tab: Tab, env: ProcessEnv, s: ScanState): void {
  const { fn, args, line, context } = call;
  if (CREATE_FNS.has(fn)) {
    const name = nameOf(args[0] ?? "", env);
    if (name)
      (fn === "cubecreate" ? s.createdCubes : s.createdDims).add(
        tm1NameKey(name),
      );
    return;
  }
  if (UNCHECKED_FNS.has(fn)) return;

  const addRef = (into: Found, argText: string | undefined) => {
    if (argText === undefined) return;
    const name = nameOf(argText, env);
    if (name === null) {
      s.unresolvable++;
      return;
    }
    if (name === "" || into.has(name)) return;
    into.set(name, { tab, line, context });
  };
  const cubeIdx = argIndex(TI_ARG_IDX.cube, fn);
  const dimIdx = argIndex(TI_ARG_IDX.dimension, fn);
  addRef(s.cubeRefs, argAt(args, cubeIdx));
  addRef(s.dimRefs, argAt(args, dimIdx));

  if (CELL_FNS.has(fn) && cubeIdx !== undefined) {
    const cubeArg = argAt(args, cubeIdx);
    // An unresolvable cube is already counted by the cube scan above.
    const cube = cubeArg === undefined ? null : nameOf(cubeArg, env);
    if (cube) {
      s.cellCalls.push({
        cube,
        elements: args.slice(cubeIdx + 1).map((a) => nameOf(a, env)),
        tab,
        line,
        context,
      });
    }
  }

  if (INSERT_FNS.has(fn)) {
    const dimArg = argAt(args, dimIdx);
    const elArg = argAt(args, argIndex(TI_ARG_IDX.element, fn));
    if (dimArg === undefined || elArg === undefined) return;
    const dim = nameOf(dimArg, env);
    if (!dim) {
      s.inserts.dynamicAnyDim = true;
      return;
    }
    const el = nameOf(elArg, env);
    const k = tm1NameKey(dim);
    if (!el) {
      s.inserts.dynamicDims.add(k);
      return;
    }
    if (!s.inserts.literal.has(k)) s.inserts.literal.set(k, new Set());
    s.inserts.literal.get(k)!.add(tm1NameKey(el));
  }
}

// Same-tab identity of a name argument: its literal value when it has one,
// otherwise the expression text itself (vEl in the insert and in the AttrPut
// is the same element on that record).
function argKey(argText: string, env: ProcessEnv): string {
  const lit = nameOf(argText, env);
  return lit !== null
    ? `'${tm1NameKey(lit)}`
    : argText.toLowerCase().replace(/\s+/g, "");
}

function scanUncommitted(
  calls: Call[],
  tab: Tab,
  env: ProcessEnv,
  into: RefIssue[],
): void {
  if (!QUEUED_INSERT_TABS.has(tab)) return;
  // dimension key → element key → offset of the first insert
  const inserted = new Map<string, Map<string, number>>();
  for (const { fn, args, offset } of calls) {
    if (!QUEUED_INSERT_FNS.has(fn)) continue;
    const dimArg = argAt(args, argIndex(TI_ARG_IDX.dimension, fn));
    const elArg = argAt(args, argIndex(TI_ARG_IDX.element, fn));
    if (dimArg === undefined || elArg === undefined) continue;
    const dk = argKey(dimArg, env);
    if (!inserted.has(dk)) inserted.set(dk, new Map());
    const els = inserted.get(dk)!;
    const ek = argKey(elArg, env);
    if (!els.has(ek)) els.set(ek, offset);
  }
  if (inserted.size === 0) return;
  for (const { fn, args, line, context, offset } of calls) {
    if (!ATTR_PUT_FNS.has(fn)) continue;
    const dimArg = argAt(args, argIndex(TI_ARG_IDX.dimension, fn));
    const elArg = argAt(args, attrElementIndex(fn, args));
    if (dimArg === undefined || elArg === undefined) continue;
    const at = inserted.get(argKey(dimArg, env))?.get(argKey(elArg, env));
    if (at === undefined || at > offset) continue;
    into.push({
      kind: "uncommittedElement",
      name: nameOf(elArg, env) ?? elArg.trim(),
      dimension: nameOf(dimArg, env) ?? dimArg.trim(),
      tab,
      line,
      context,
    });
  }
}

/** Parse-time half: collect the references, no server round-trip. */
function scanProcessRefs(code: ProcessCode): {
  cubeRefs: Found;
  dimRefs: Found;
  createdCubes: Set<string>;
  createdDims: Set<string>;
  tabsChecked: Tab[];
  unresolvableArgs: number;
  cellCalls: CellCall[];
  inserts: Inserts;
  uncommitted: RefIssue[];
} {
  // Variable env across all tabs in runtime order: a prolog assignment
  // like sCube = 'Sales'; makes CellGetN(sCube, ...) resolvable. Params
  // are unknown here (only code is scanned), so param-fed identifiers
  // stay unresolvable — conservative.
  const env = buildProcessEnv(TABS.map((t) => code[t] ?? "").join("\n"), []);
  const s: ScanState = {
    cubeRefs: new Map(),
    dimRefs: new Map(),
    createdCubes: new Set(),
    createdDims: new Set(),
    cellCalls: [],
    inserts: {
      literal: new Map(),
      dynamicDims: new Set(),
      dynamicAnyDim: false,
    },
    unresolvable: 0,
  };
  const tabsChecked: Tab[] = [];
  const uncommitted: RefIssue[] = [];
  for (const tab of TABS) {
    const c = code[tab];
    if (!c || c.trim() === "") continue;
    tabsChecked.push(tab);
    const calls: Call[] = [];
    forEachCall(c, CALL_RE, (fn, args, line, context, offset) =>
      calls.push({ fn, args, line, context, offset }),
    );
    for (const call of calls) scanCall(call, tab, env, s);
    scanUncommitted(calls, tab, env, uncommitted);
  }
  return {
    cubeRefs: s.cubeRefs,
    dimRefs: s.dimRefs,
    createdCubes: s.createdCubes,
    createdDims: s.createdDims,
    tabsChecked,
    unresolvableArgs: s.unresolvable,
    cellCalls: s.cellCalls,
    inserts: s.inserts,
    uncommitted,
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
        .filter((o) => includeControl || !isControlName(o.name))
        .map((o) => tm1NameKey(o.name)),
    );
  const cubeNames = known(cubes);
  const dimNames = known(dims);

  const issues: RefIssue[] = [];
  for (const [name, info] of scan.cubeRefs) {
    const k = tm1NameKey(name);
    if (!cubeNames.has(k) && !scan.createdCubes.has(k))
      issues.push({ kind: "cube", name, ...info });
  }
  for (const [name, info] of scan.dimRefs) {
    const k = tm1NameKey(name);
    if (!dimNames.has(k) && !scan.createdDims.has(k))
      issues.push({ kind: "dimension", name, ...info });
  }
  const elementCheck = await checkElementRefs(catalogue, scan, cubeNames);
  issues.push(...elementCheck.issues, ...scan.uncommitted);
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
  if (!cubesSvc.getDimensionNames) {
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
            cubeNames.has(tm1NameKey(c)) &&
            !scan.createdCubes.has(tm1NameKey(c)),
        ),
    ),
  ];
  const dimsOf = new Map<string, string[]>();
  await Promise.all(
    cubes.map(async (c) => {
      const all = await cubesSvc.getDimensionNames!(c);
      // TI's cell functions never take the Sandboxes dimension.
      dimsOf.set(tm1NameKey(c), withoutSandboxes(all));
    }),
  );

  const countIssues: RefIssue[] = [];
  for (const call of scan.cellCalls) {
    const dims = dimsOf.get(tm1NameKey(call.cube));
    if (dims && dims.length !== call.elements.length)
      countIssues.push({
        kind: "elementCount",
        name: call.cube,
        expected: dims.length,
        got: call.elements.length,
        tab: call.tab,
        line: call.line,
        context: call.context,
      });
  }
  if (!elements || scan.inserts.dynamicAnyDim) {
    return { issues: countIssues, scanned: 0, overflow: 0 };
  }

  // Distinct (dimension, element) pairs, first occurrence kept for the report.
  const pending = new Map<
    string,
    { dim: string; el: string; call: CellCall }
  >();
  for (const call of scan.cellCalls) {
    const dims = dimsOf.get(tm1NameKey(call.cube));
    if (!dims || dims.length !== call.elements.length) continue;
    call.elements.forEach((el, i) => {
      if (!el) return; // null (not a literal) or empty: nothing to look up
      const dim = dims[i]!;
      const dk = tm1NameKey(dim);
      if (scan.inserts.dynamicDims.has(dk)) return;
      if (scan.inserts.literal.get(dk)?.has(tm1NameKey(el))) return;
      const key = `${dk}\u0000${tm1NameKey(el)}`;
      if (!pending.has(key)) pending.set(key, { dim, el, call });
    });
  }

  const todo = [...pending.values()];
  const checked = todo.slice(0, ELEMENT_LOOKUP_MAX);
  const settled = await mapSettledWithConcurrency(checked, 8, ({ dim, el }) =>
    elementResolves(elements, dim, el),
  );
  // A lookup that failed for any reason other than "not found" (auth,
  // transport, denial) must surface, not read as a missing element.
  const found = settled.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
  const issues = countIssues;
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
// be part of a plain element name, so both readings are tried. The rules DB()
// check uses this too: trying both readings can excuse a name, never flag one.
export async function elementResolves(
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
