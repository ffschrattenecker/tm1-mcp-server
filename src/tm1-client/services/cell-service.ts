// Cell domain service. Owns single-cell reads, MDX cellset execution, and
// cell writes via the cellset PATCH path. Cube-shape lookups (resolving
// dimension order for getValue) go through the shared DimensionOrderCache
// rather than CubeService to avoid a CubeService → CellService cycle later.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  CalculationTraceNode,
  CellProbe,
  CellValue,
  FedCellDescriptor,
  FeederTraceResult,
  LeafTuples,
  MdxResult,
} from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";
import { escapeMdxName } from "../../lib/mdx.js";
import { dimensionCountMismatch } from "../../lib/coordinate-error.js";
import { bindLeftOutSandbox, sandboxPosition } from "../../lib/cell-address.js";
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import { freeCellset, transformCellsetResponse } from "./cellset-transform.js";
import { odataKey } from "./odata-page.js";
import { DimensionOrderCache } from "./dimension-order.js";

// In-flight cap for the per-cell re-walk after a refused bulk write.
const FALLBACK_CONCURRENCY = 8;

/**
 * Split one entry of a cell coordinate into (hierarchy, element).
 *
 * A bare name addresses the dimension's DEFAULT hierarchy, which carries the
 * dimension's own name. `Hier:Elem` addresses an alternate hierarchy — the
 * same `Dim:Hier` idiom TM1 rules use, one slot down.
 *
 * The split takes the FIRST colon, and the dimension's default hierarchy can
 * always be named explicitly, so an element whose own name contains a colon
 * stays reachable: in dimension `Region`, `Region:A:B` is element `A:B` in
 * the default hierarchy. A leading or trailing colon cannot separate anything,
 * so such an entry is taken as a plain element name.
 */
function splitHierarchyQualified(
  entry: string,
  dimension: string,
): { hierarchy: string; element: string } {
  const i = entry.indexOf(":");
  if (i <= 0 || i === entry.length - 1)
    return { hierarchy: dimension, element: entry };
  return { hierarchy: entry.slice(0, i), element: entry.slice(i + 1) };
}

// Inverse of splitHierarchyQualified: the entry that addresses `element` in
// `hierarchy`. The default hierarchy is written bare unless the name holds a
// colon, which would otherwise be read as a hierarchy prefix.
function joinHierarchyQualified(
  dimension: string,
  hierarchy: string,
  element: string,
): string {
  if (hierarchy === dimension && !element.includes(":")) return element;
  return `${hierarchy}:${element}`;
}

// `[Dim].[Hier].[Elem]` for a coordinate entry, `]`-escaped.
function mdxMember(dimension: string, entry: string): string {
  const { hierarchy, element } = splitHierarchyQualified(entry, dimension);
  return `[${escapeMdxName(dimension)}].[${escapeMdxName(hierarchy)}].[${escapeMdxName(element)}]`;
}

// Tuples per probe query — keeps the MDX text and the cellset small.
const PROBE_CHUNK = 100;

function hasValue(v: CellValue): boolean {
  return typeof v === "number" ? v !== 0 : typeof v === "string" && v !== "";
}

// Build a fully-qualified MDX member reference for a write coordinate.
// A caller may pass a pre-qualified ref to target an ALTERNATE hierarchy
// (`[Dim].[AltHier].[Elem]`, or `[Dim].[Elem]` for the default) — passed
// through unchanged (caller owns escaping). A bare element defaults the
// hierarchy to the dimension name (`[Dim].[Dim].[Elem]`); every bare name
// component is `]`-escaped so a `]` in a name cannot mis-address the cell.
function qualifyWriteMember(dim: string, element: string): string {
  const d = escapeMdxName(dim);
  if (element.startsWith("[") && element.includes("].[")) return element;
  if (element.startsWith("[") && element.endsWith("]"))
    return `[${d}].[${d}].${element}`;
  return `[${d}].[${d}].[${escapeMdxName(element)}]`;
}

export class CellService {
  constructor(
    private readonly http: TM1HttpClient,
    private readonly dimOrder: DimensionOrderCache = new DimensionOrderCache(
      http,
    ),
  ) {}

  /**
   * Get a single cell value via a 1-tuple MDX query.
   *
   * TM1 11.8 returns 0 cells for `SELECT {} ON COLUMNS WHERE (...)` — the
   * empty axis collapses the cellset. Put the first element on COLUMNS and
   * the rest in WHERE to force a 1-cell cellset. Each element is qualified
   * with its dimension to avoid name collisions in control cubes.
   */
  async getValue(cubeName: string, elements: string[]): Promise<CellValue> {
    if (elements.length === 0) {
      return null;
    }

    const dims = await this.dimOrder.get(cubeName);
    // Sandboxes left out → Base, as tm1_write_cells does.
    elements = bindLeftOutSandbox(dims, elements) ?? elements;
    if (elements.length !== dims.length) {
      throw dimensionCountMismatch(cubeName, dims, elements);
    }
    const qualify = (dim: string, element: string): string => {
      const d = escapeMdxName(dim);
      // Pre-qualified MDX member reference — pass through (caller owns escaping).
      if (element.startsWith("[") && element.includes("].[")) return element;
      // Single bracketed member like `[Foo]` — prepend dimension.
      if (element.startsWith("[") && element.endsWith("]"))
        return `[${d}].${element}`;
      return `[${d}].[${escapeMdxName(element)}]`;
    };
    const qualified = dims.map((d, i) => qualify(d, elements[i]!));
    const cube = escapeMdxName(cubeName);

    const colMember = qualified[0]!;
    const whereParts = qualified.slice(1);
    const mdx =
      whereParts.length === 0
        ? `SELECT {${colMember}} ON COLUMNS FROM [${cube}]`
        : `SELECT {${colMember}} ON COLUMNS FROM [${cube}] WHERE (${whereParts.join(",")})`;

    const cellsetResponse = await this.http.request<{
      ID: string;
      Cells?: Array<{ Value: CellValue; FormattedValue: string }>;
    }>(
      "POST",
      "/api/v1/ExecuteMDX?$expand=Cells($select=Value,FormattedValue)",
      { MDX: mdx },
    );

    try {
      if (cellsetResponse.Cells && cellsetResponse.Cells.length > 0) {
        return cellsetResponse.Cells[0]!.Value;
      }
      // The MDX selects exactly one member, so a resolvable coordinate always
      // yields one cell — an empty one comes back as a cell with a null Value.
      // No cell at all means a member did not resolve. v11 refuses that MDX
      // outright ("member not found (rte 81)"); v12 answers 200 with an empty
      // cellset, and returning null there reported "this cell is empty" for a
      // coordinate that does not exist. Both versions now fail the same way.
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `No cell resolved for cube '${cubeName}' at (${elements.join(", ")}). At least one element name does not exist in its dimension — check spelling and case with tm1_get_descendants or tm1_list_element_attributes.`,
        endpoint: "/api/v1/ExecuteMDX",
      });
    } finally {
      // Free the session-scoped cellset best-effort so single-value reads don't
      // leak TM1 server memory while keep-alive holds the session open.
      await freeCellset(this.http, cellsetResponse.ID);
    }
  }

  /**
   * Execute an MDX query and return structured cells + axes. Supports
   * pagination via top/skip on the Cells expand. opts.timeoutMs overrides the
   * 30s default for heavy queries.
   * POST /api/v1/ExecuteMDX
   */
  async executeMdx(
    mdx: string,
    top?: number,
    skip?: number,
    opts?: RequestOptions,
  ): Promise<MdxResult> {
    let cellsExpand = "Cells($select=Value,FormattedValue";
    if (top !== undefined) {
      cellsExpand += `;$top=${top}`;
    }
    if (skip !== undefined) {
      cellsExpand += `;$skip=${skip}`;
    }
    cellsExpand += ")";

    const axesExpand =
      "Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))";
    const path = `/api/v1/ExecuteMDX?$expand=${cellsExpand},${axesExpand}`;

    const response = await this.http.request<{
      ID: string;
      Cells: Array<{ Value: CellValue; FormattedValue: string }>;
      Axes: Array<{
        Tuples: Array<{
          Members: Array<{
            Name: string;
            Hierarchy: { Name: string };
          }>;
        }>;
      }>;
    }>("POST", path, { MDX: mdx }, opts);

    try {
      return transformCellsetResponse(response);
    } finally {
      // Cellsets are session-scoped and never auto-expire while keep-alive holds
      // the session open, so a read that leaves them behind leaks TM1 server
      // memory indefinitely. Free it best-effort (mirrors TM1py's delete_cellset).
      await freeCellset(this.http, response.ID, opts);
    }
  }

  /**
   * Write multiple cells via the cellset PATCH path.
   *
   * TM1 11.8's Cube /tm1.Update action rejects every documented payload
   * variant ("Invalid CellDescriptor property" / "Unexpected entity reference
   * type" / "Expecting Object or EntityBind"). The cellset PATCH path is the
   * supported route in 11.8:
   *   1. POST /api/v1/ExecuteMDX with a slice MDX over the target cell
   *   2. PATCH /api/v1/Cellsets('{id}')/Cells(0) with {Value}
   *   3. DELETE /api/v1/Cellsets('{id}')
   *
   * Values can be numeric (for N-cubes) or strings (for string cells). Writes
   * to consolidated cells are rejected by TM1.
   *
   * Prefer TI processes for reproducible data loads. Use this REST path only
   * for ad-hoc / debugging writes.
   */
  async writeCells(
    cubeName: string,
    dimensions: string[],
    cells: Array<{ elements: string[]; value: number | string }>,
  ): Promise<void> {
    if (cells.length === 0) return;

    for (const c of cells) {
      if (c.elements.length !== dimensions.length) {
        throw dimensionCountMismatch(cubeName, dimensions, c.elements);
      }
    }

    const cube = escapeMdxName(cubeName);
    const tupleOf = (c: { elements: string[] }) => {
      const refs = c.elements.map((e, idx) =>
        qualifyWriteMember(dimensions[idx]!, e),
      );
      return refs.length === 1 ? refs[0]! : `(${refs.join(",")})`;
    };

    // One cell at a time cost three requests each — cellset, PATCH, delete —
    // which measured 120 requests for 40 cells. TM1py (and tm1npm, which ports
    // it) build ONE cellset over every target coordinate and PATCH the whole
    // cell array once; verified against 11.8 at 40 cells in 3 requests, 9 ms.
    //
    // The array goes out BARE. `{Cells: [...]}` — what tm1npm sends — is
    // refused with "Invalid CellsetCell property encountered in payload".
    //
    // Ordinals are positional, and TM1 does not collapse a repeated tuple in a
    // set (verified), so cells[i] stays ordinal i even when a caller sends the
    // same coordinate twice.
    const writeOne = async (c: {
      elements: string[];
      value: number | string;
    }) => {
      const mdx = `SELECT {${tupleOf(c)}} ON COLUMNS FROM [${cube}]`;
      const cellset = await this.http.request<{ ID: string }>(
        "POST",
        "/api/v1/ExecuteMDX",
        { MDX: mdx },
      );
      const id = cellset.ID;
      try {
        await this.http.request<void>(
          "PATCH",
          `/api/v1/Cellsets('${odataKey(id)}')/Cells(0)`,
          { Value: c.value },
        );
      } finally {
        try {
          await this.http.request<void>(
            "DELETE",
            `/api/v1/Cellsets('${odataKey(id)}')`,
          );
        } catch {
          // cleanup best-effort
        }
      }
    };

    // Chunked because the MDX carries one tuple per cell: 2000 tuples measured
    // at 194 KB and 90 ms, so this stays far inside what the server and any
    // proxy in front of it accept.
    const CHUNK = 500;
    let written = 0;

    for (let i = 0; i < cells.length; i += CHUNK) {
      const chunk = cells.slice(i, i + CHUNK);
      const mdx = `SELECT {${chunk.map(tupleOf).join(",")}} ON COLUMNS FROM [${cube}]`;

      let bulkFailed = false;
      const cellset = await this.http.request<{ ID: string }>(
        "POST",
        "/api/v1/ExecuteMDX",
        { MDX: mdx },
      );
      try {
        await this.http.request<void>(
          "PATCH",
          `/api/v1/Cellsets('${odataKey(cellset.ID)}')/Cells`,
          chunk.map((c, ordinal) => ({ Ordinal: ordinal, Value: c.value })),
        );
        written += chunk.length;
      } catch {
        // A chunk holding one non-writable cell is refused WHOLE — nothing
        // lands, not even the writable cells (measured:
        // CubeCellWriteStatusElementIsConsolidated). The error names the
        // status, never the coordinate, so the only way to tell the caller
        // WHICH cell was refused is to re-walk this chunk one cell at a time.
        // That is the old cost, paid only on the failing path.
        bulkFailed = true;
      } finally {
        try {
          await this.http.request<void>(
            "DELETE",
            `/api/v1/Cellsets('${odataKey(cellset.ID)}')`,
          );
        } catch {
          // cleanup best-effort
        }
      }

      if (!bulkFailed) continue;

      // Bounded: re-walking a 500-cell chunk unbounded put ~1500 requests
      // (cellset, PATCH, delete per cell) in flight against the worker pool.
      const results = await mapSettledWithConcurrency(
        chunk,
        FALLBACK_CONCURRENCY,
        (c) => writeOne(c),
      );
      const failed: Array<{ elements: string[]; error: string }> = [];
      results.forEach((r, j) => {
        if (r.status === "fulfilled") {
          written++;
        } else {
          failed.push({
            elements: chunk[j]!.elements,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      });

      if (failed.length > 0) {
        const notAttempted = cells.length - (i + chunk.length);
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message:
            `write_cells partially applied to '${cubeName}': ${written} written, ` +
            `${failed.length} failed, ${notAttempted} not attempted. ` +
            `Earlier writes are committed and will NOT be rolled back.`,
          details: JSON.stringify({ written, failed, notAttempted }),
          hint:
            "Inspect `details` for the failed coordinates. Successful cells are already committed — " +
            "retry ONLY the failed + notAttempted coords (re-sending written cells is harmless but wasteful). " +
            "Validate targets first with tm1_check_writable_coords.",
        });
      }
    }
  }

  /**
   * Resolve the cube's dimension order and build Tuple@odata.bind paths for
   * the cell-bound trace actions. Each entry addresses the dimension's default
   * hierarchy, or an alternate one when written `Hier:Elem` — see
   * splitHierarchyQualified().
   */
  private async tupleBinds(
    cubeName: string,
    elements: string[],
  ): Promise<string[]> {
    const dims = await this.dimOrder.get(cubeName);
    // Sandboxes left out → Base, as tm1_get_cell_value does.
    elements = bindLeftOutSandbox(dims, elements) ?? elements;
    if (elements.length !== dims.length) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `Cube '${cubeName}' has ${dims.length} dimension(s) (${dims.join(", ")}) but ${elements.length} element(s) were given`,
      });
    }
    return dims.map((d, i) => {
      const { hierarchy, element } = splitHierarchyQualified(elements[i]!, d);
      return `Dimensions('${odataKey(d)}')/Hierarchies('${odataKey(hierarchy)}')/Elements('${odataKey(element)}')`;
    });
  }

  /**
   * Check the feeders of a cell: returns the cells fed by this cell with a
   * Fed flag per target — Fed=false marks a broken/missing feeder.
   * POST /api/v1/Cubes('{cube}')/tm1.CheckFeeders
   */
  async checkFeeders(
    cubeName: string,
    elements: string[],
    opts?: RequestOptions,
  ): Promise<FedCellDescriptor[]> {
    const binds = await this.tupleBinds(cubeName, elements);
    const response = await this.http.request<{
      value?: Array<RawFedCell>;
    }>(
      "POST",
      `/api/v1/Cubes('${odataKey(cubeName)}')/tm1.CheckFeeders?$expand=Cube($select=Name),Tuple($select=Name)`,
      { "Tuple@odata.bind": binds },
      opts,
    );
    return (response.value ?? []).map(mapFedCell);
  }

  /**
   * Trace the feeders of a cell: returns the cells this cell feeds plus the
   * feeder statements involved.
   * POST /api/v1/Cubes('{cube}')/tm1.TraceFeeders
   */
  async traceFeeders(
    cubeName: string,
    elements: string[],
    opts?: RequestOptions,
  ): Promise<FeederTraceResult> {
    const binds = await this.tupleBinds(cubeName, elements);
    const response = await this.http.request<{
      FedCells?: Array<RawFedCell>;
      Statements?: string[];
    }>(
      "POST",
      `/api/v1/Cubes('${odataKey(cubeName)}')/tm1.TraceFeeders?$expand=FedCells/Cube($select=Name),FedCells/Tuple($select=Name)`,
      { "Tuple@odata.bind": binds },
      opts,
    );
    return {
      fedCells: (response.FedCells ?? []).map(mapFedCell),
      statements: response.Statements ?? [],
    };
  }

  /**
   * Read the live fed state of cells: one plain read (value, RuleDerived,
   * Consolidated — it also proves every member resolves), then the same set
   * under NON EMPTY. A cell with a value that NON EMPTY drops is unfed; an
   * empty or zero cell is dropped either way, so its fed state is unknown.
   * The tuples go on COLUMNS only, so NON EMPTY judges each cell on its own.
   */
  async probeCells(
    cubeName: string,
    tuples: string[][],
    opts?: RequestOptions,
  ): Promise<CellProbe[]> {
    const dims = await this.dimOrder.get(cubeName);
    // Sandboxes left out → Base; trace actions return target tuples that way.
    const bound = tuples.map((t) => bindLeftOutSandbox(dims, t) ?? t);
    for (const t of bound) {
      if (t.length !== dims.length)
        throw dimensionCountMismatch(cubeName, dims, t);
    }
    const cube = escapeMdxName(cubeName);
    const out: CellProbe[] = [];
    for (let i = 0; i < tuples.length; i += PROBE_CHUNK) {
      const chunk = tuples.slice(i, i + PROBE_CHUNK);
      const set = `{${bound
        .slice(i, i + PROBE_CHUNK)
        .map((t) => `(${dims.map((d, j) => mdxMember(d, t[j]!)).join(",")})`)
        .join(",")}}`;
      // Same Axes/Cells shape as executeMdx, so the wire contract covers it.
      const axes =
        "Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))";
      const plain = await this.http.request<RawProbeCellset>(
        "POST",
        `/api/v1/ExecuteMDX?$expand=Cells($select=Value,FormattedValue,RuleDerived,Consolidated),${axes}`,
        { MDX: `SELECT ${set} ON 0 FROM [${cube}]` },
        opts,
      );
      let kept: Set<string>;
      try {
        const nonEmpty = await this.http.request<RawProbeCellset>(
          "POST",
          `/api/v1/ExecuteMDX?$expand=${axes}`,
          { MDX: `SELECT NON EMPTY ${set} ON 0 FROM [${cube}]` },
          opts,
        );
        try {
          kept = new Set(axisKeys(nonEmpty));
        } finally {
          await freeCellset(this.http, nonEmpty.ID, opts);
        }
        const keys = axisKeys(plain);
        const cells = plain.Cells ?? [];
        if (keys.length !== chunk.length || cells.length !== chunk.length) {
          throw new TM1Error({
            code: TM1ErrorCode.NOT_FOUND,
            message: `Probe of cube '${cubeName}' resolved ${cells.length} of ${chunk.length} cell(s). At least one element name does not exist in its dimension.`,
            endpoint: "/api/v1/ExecuteMDX",
          });
        }
        chunk.forEach((tuple, k) => {
          const c = cells[k]!;
          const value = c.Value ?? null;
          out.push({
            tuple,
            value,
            ruleDerived: c.RuleDerived === true,
            consolidated: c.Consolidated === true,
            fed: kept.has(keys[k]!) ? true : hasValue(value) ? false : null,
          });
        });
      } finally {
        await freeCellset(this.http, plain.ID, opts);
      }
    }
    return out;
  }

  /**
   * Expand a coordinate to its leaf combinations: every consolidated entry is
   * replaced by the leaves beneath it (in its own hierarchy), capped at
   * maxCells. One axis-only query per dimension; no cells are fetched.
   */
  async leafTuples(
    cubeName: string,
    elements: string[],
    maxCells: number,
    opts?: RequestOptions,
  ): Promise<LeafTuples> {
    const dims = await this.dimOrder.get(cubeName);
    const bound = bindLeftOutSandbox(dims, elements);
    elements = bound ?? elements;
    if (elements.length !== dims.length)
      throw dimensionCountMismatch(cubeName, dims, elements);
    const cube = escapeMdxName(cubeName);
    const sandbox = sandboxPosition(dims);
    const perDim: string[][] = [];
    for (let j = 0; j < dims.length; j++) {
      const d = dims[j]!;
      if (j === sandbox) {
        perDim.push([elements[j]!]);
        continue;
      }
      const { hierarchy } = splitHierarchyQualified(elements[j]!, d);
      const where = dims
        .map((dd, k) => (k === j ? null : mdxMember(dd, elements[k]!)))
        .filter((m): m is string => m !== null);
      const mdx =
        `SELECT {TM1FILTERBYLEVEL({DESCENDANTS(${mdxMember(d, elements[j]!)})}, 0)} ON 0 FROM [${cube}]` +
        (where.length > 0 ? ` WHERE (${where.join(",")})` : "");
      const res = await this.http.request<RawProbeCellset>(
        "POST",
        `/api/v1/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))`,
        { MDX: mdx },
        opts,
      );
      try {
        const names = (res.Axes?.[0]?.Tuples ?? []).map(
          (t) => t.Members?.[0]?.Name ?? "",
        );
        perDim.push(
          [...new Set(names)].map((n) =>
            joinHierarchyQualified(d, hierarchy, n),
          ),
        );
      } finally {
        await freeCellset(this.http, res.ID, opts);
      }
    }
    const total = perDim.reduce((n, l) => n * l.length, 1);
    const tuples: string[][] = [];
    const walk = (j: number, acc: string[]): void => {
      if (tuples.length >= maxCells) return;
      if (j === perDim.length) {
        tuples.push([...acc]);
        return;
      }
      for (const e of perDim[j]!) {
        acc.push(e);
        walk(j + 1, acc);
        acc.pop();
        if (tuples.length >= maxCells) return;
      }
    };
    if (total > 0) walk(0, []);
    // Hand tuples back in the caller's shape: a left-out Sandboxes stays out.
    if (bound) for (const t of tuples) t.splice(sandbox, 1);
    return { tuples, total, truncated: total > tuples.length };
  }

  /**
   * Trace how a cell value is calculated: recursive component tree with
   * per-component type (consolidation/rule), status, value, and rule
   * statements. The server returns the full tree; maxDepth/maxComponents
   * truncate client-side to keep responses bounded.
   * POST /api/v1/Cubes('{cube}')/tm1.TraceCellCalculation
   */
  async traceCellCalculation(
    cubeName: string,
    elements: string[],
    maxDepth = 3,
    maxComponents = 20,
    opts?: RequestOptions,
  ): Promise<CalculationTraceNode> {
    const binds = await this.tupleBinds(cubeName, elements);
    // Components is a complex-type collection — nested nav-prop expand uses
    // the path form (Components/Tuple); ($levels=...) is rejected by 11.8.
    // Each path segment covers exactly one tree level, so emit one
    // Components/.../{Tuple,Cube} pair per requested depth — without them,
    // deeper nodes carry values but no coordinates (and no cube for
    // cross-cube DB() components), making drill-down impossible.
    const expandParts = ["Tuple($select=Name)"];
    for (let level = 1; level <= maxDepth; level++) {
      const prefix = "Components/".repeat(level);
      expandParts.push(
        `${prefix}Tuple($select=Name)`,
        `${prefix}Cube($select=Name)`,
      );
    }
    const response = await this.http.request<RawCalcComponent>(
      "POST",
      `/api/v1/Cubes('${odataKey(cubeName)}')/tm1.TraceCellCalculation?$expand=${expandParts.join(",")}`,
      { "Tuple@odata.bind": binds },
      opts,
    );
    return mapCalcComponent(response, maxDepth, maxComponents);
  }
}

// Raw OData shapes for the trace actions. Cube/Tuple are navigation
// properties — present only when the $expand is honored, hence optional.
interface RawFedCell {
  Cube?: { Name?: string };
  Tuple?: Array<{ Name?: string }>;
  Fed?: boolean;
}

interface RawCalcComponent {
  Type?: string;
  Status?: string;
  Value?: CellValue;
  Cube?: { Name?: string };
  Tuple?: Array<{ Name?: string }>;
  Statements?: string[];
  Components?: RawCalcComponent[];
}

interface RawProbeCellset {
  ID?: string;
  Cells?: Array<{
    Value?: CellValue;
    RuleDerived?: boolean;
    Consolidated?: boolean;
  }>;
  Axes?: Array<{ Tuples?: Array<{ Members?: Array<{ Name?: string }> }> }>;
}

// One key per column tuple — TM1's canonical member names, so the plain and
// NON EMPTY reads of the same set match regardless of how the caller cased them.
function axisKeys(res: RawProbeCellset): string[] {
  return (res.Axes?.[0]?.Tuples ?? []).map((t) =>
    (t.Members ?? []).map((m) => m.Name ?? "").join("\u0000"),
  );
}

function mapFedCell(raw: RawFedCell): FedCellDescriptor {
  return {
    cube: raw.Cube?.Name ?? "",
    tuple: (raw.Tuple ?? []).map((t) => t.Name ?? ""),
    fed: raw.Fed === true,
  };
}

function mapCalcComponent(
  raw: RawCalcComponent,
  depthLeft: number,
  maxComponents: number,
): CalculationTraceNode {
  const node: CalculationTraceNode = { value: raw.Value ?? null };
  if (raw.Type !== undefined) node.type = raw.Type;
  if (raw.Status !== undefined) node.status = raw.Status;
  if (raw.Cube?.Name !== undefined) node.cube = raw.Cube.Name;
  if (raw.Tuple !== undefined) node.tuple = raw.Tuple.map((t) => t.Name ?? "");
  if (raw.Statements !== undefined && raw.Statements.length > 0)
    node.statements = raw.Statements;

  const children = raw.Components ?? [];
  if (children.length > 0) {
    if (depthLeft <= 0) {
      node.truncated = true;
    } else {
      const kept = children.slice(0, maxComponents);
      node.components = kept.map((c) =>
        mapCalcComponent(c, depthLeft - 1, maxComponents),
      );
      if (children.length > maxComponents) node.truncated = true;
    }
  }
  return node;
}
