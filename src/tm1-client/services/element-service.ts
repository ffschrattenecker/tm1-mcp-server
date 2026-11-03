// Element domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements(...) — create, update,
// delete, move, bulk upsert, ElementAttribute definition CRUD, plus the
// element-attribute VALUE read/write that goes through the
// `}ElementAttributes_{Dim}` control cube. Those last two methods route
// through CellService for the underlying MDX read and cellset PATCH.
//
// See docs/ARCHITECTURE.md for the layering.
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { CellValue, ElementCreate } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { BatchUnsupportedError } from "./batch-service.js";
import type {
  BatchRequest,
  BatchService,
  BatchSubResult,
} from "./batch-service.js";
import type { CellService } from "./cell-service.js";
import { rethrowIfSystemic } from "./fallback.js";
import { escapeOdataLiteral, odataKey } from "./odata-page.js";
import { escapeMdxName } from "../../lib/mdx.js";

// Max in-flight REST calls when requests go one at a time (no $batch). Bounds
// pressure on TM1's worker pool (mirrors the cap the feeder-audit fan-out uses)
// while removing the serialized 2-3N round-trips on an explicitly-bulk op.
const BULK_UPSERT_CONCURRENCY = 8;

/** Read-only preview of {@link ElementService.bulkUpsert}. */
export interface BulkUpsertPlan {
  creates: string[];
  updates: string[];
  typeChanges: Array<{ name: string; from: string; to: string }>;
  /** Existing children a components list would drop, per consolidation. */
  removals: Array<{ parent: string; children: string[] }>;
}

/** Outcome of one element in {@link ElementService.deleteMany}. */
export interface ElementDeleteResult {
  elementName: string;
  deleted: boolean;
  error?: { code: string; message: string };
}

// Names per `consolidatedAmong` request. Keeps the generated $filter well
// inside any proxy URL limit while still costing one round-trip for the
// element count a normal write carries.
const CONSOLIDATED_PROBE_CHUNK = 50;

// TM1 signals "element already exists" with different HTTP statuses across
// versions: some return 409 Conflict, but v11.x (REST 11.8) returns 400 with
// the message "An element with name ... already exists". Detect both so bulk
// upsert stays idempotent (update existing) rather than throwing on re-upsert.
export function isAlreadyExists(err: TM1Error): boolean {
  if (err.httpStatus === 409) return true;
  if (err.httpStatus === 400) {
    const text = `${err.message} ${err.details ?? ""}`.toLowerCase();
    return text.includes("already exists");
  }
  return false;
}

// TM1 may report an element's Type as the enum name ("Numeric"|"String"|
// "Consolidated") or its ordinal (1|2|3). Normalize to the name so callers can
// compare against ElementCreate.type regardless of representation.
function normalizeElementType(t: number | string): string {
  switch (t) {
    case 1:
    case "1":
      return "Numeric";
    case 2:
    case "2":
      return "String";
    case 3:
    case "3":
      return "Consolidated";
    default:
      return String(t);
  }
}

/**
 * Reject with the first failure in ELEMENT order (not response order), so the
 * error a caller sees is the same one the per-request path would surface.
 * Successful sub-requests in the same batch stay committed — TM1's $batch is
 * non-atomic — exactly as the per-request fallback already leaves
 * earlier writes committed when a later one fails.
 */
function throwFirstFailure(
  results: BatchSubResult[],
  indexOf: (id: string) => number,
): void {
  let firstIndex = Number.POSITIVE_INFINITY;
  let firstError: TM1Error | undefined;
  for (const r of results) {
    if (r.ok) continue;
    const i = indexOf(r.id);
    if (i < firstIndex) {
      firstIndex = i;
      firstError = r.error;
    }
  }
  if (firstError) throw firstError;
}

/**
 * One HTTP call per request, with the same contract as BatchService.execute:
 * one result per request, in the order given. Calls fan out with the bulk
 * concurrency cap. A failed call is data (`ok: false`, the TM1Error it threw).
 * A systemic transport/auth failure throws, as a whole-envelope failure does on
 * the batch path. Used only when the server has no usable `$batch`, through
 * ElementService.execute.
 *
 * The per-request path never sees a success's HTTP status, so a success reports
 * `status: 0`; a failure reports the status its error carried.
 */
async function executePerRequest(
  http: TM1HttpClient,
  requests: BatchRequest[],
): Promise<BatchSubResult[]> {
  const settled = await mapSettledWithConcurrency(
    requests,
    BULK_UPSERT_CONCURRENCY,
    (r) => http.request<unknown>(r.method, r.path, r.body),
  );
  return settled.map((s, i): BatchSubResult => {
    const { id } = requests[i]!;
    if (s.status === "fulfilled") {
      return { id, status: 0, ok: true, body: s.value };
    }
    rethrowIfSystemic(s.reason);
    const error = s.reason as TM1Error;
    return { id, status: error.httpStatus ?? 0, ok: false, error };
  });
}

export class ElementService {
  constructor(
    private readonly http: TM1HttpClient,
    private readonly cells: CellService,
    // Optional so a caller (and the existing unit tests) can build an
    // ElementService that only ever uses the per-request path. Production wires
    // it, which turns bulkUpsert's N round-trips into a handful of $batch calls.
    private readonly batch?: BatchService,
  ) {}

  /**
   * Run `requests` through `$batch` when the server has it, one request per
   * call otherwise. This is the only place the fallback happens. Both branches
   * honour the BatchService.execute contract: one result per request, in the
   * order given; a failing request is data; a systemic failure throws.
   *
   * Falls back only on BatchUnsupportedError. BatchService raises that only
   * before the first successful batch on the connection, and skips the batch
   * outright once it is known unsupported. See bulkUpsert's pass 1a for why
   * that is safe.
   */
  private async execute(requests: BatchRequest[]): Promise<BatchSubResult[]> {
    if (this.batch && !this.batch.isKnownUnsupported) {
      try {
        return await this.batch.execute(requests);
      } catch (err) {
        if (!(err instanceof BatchUnsupportedError)) throw err;
      }
    }
    return executePerRequest(this.http, requests);
  }

  /**
   * What a bulkUpsert of `elements` would do, read-only: which elements it
   * creates, which it updates, which change type in place (a Numeric ->
   * Consolidated/String conversion discards leaf data), and which existing
   * children a `components` list would drop — components REPLACE the child
   * set, they do not append.
   *
   * Computed BEFORE any write on purpose: bulkUpsert's $batch pass commits its
   * creates as it goes (TM1's $batch is non-atomic), so a plan worked out
   * afterwards could only report damage, not prevent it.
   *
   * One filtered read per 40 names — `Elements?$filter=Name eq … or …` with
   * the edges expanded — instead of loading the hierarchy.
   */
  async planBulkUpsert(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<BulkUpsertPlan> {
    const base = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements`;
    const lit = (n: string) => `'${escapeOdataLiteral(n)}'`;
    const current = new Map<string, { type: string; children: string[] }>();
    const names = [...new Set(elements.map((e) => e.name))];
    for (let i = 0; i < names.length; i += 40) {
      const chunk = names.slice(i, i + 40);
      const filter = chunk.map((n) => `Name eq ${lit(n)}`).join(" or ");
      const page = await this.http.request<{
        value: Array<{
          Name: string;
          Type: string;
          Edges?: Array<{ ComponentName: string }>;
        }>;
      }>(
        "GET",
        `${base}?$select=Name,Type&$expand=Edges($select=ComponentName)&$filter=${encodeURIComponent(filter)}`,
      );
      for (const e of page.value)
        current.set(e.Name.toLowerCase(), {
          type: e.Type,
          children: (e.Edges ?? []).map((x) => x.ComponentName),
        });
    }
    const plan: BulkUpsertPlan = {
      creates: [],
      updates: [],
      typeChanges: [],
      removals: [],
    };
    for (const el of elements) {
      const now = current.get(el.name.toLowerCase());
      if (!now) {
        plan.creates.push(el.name);
        continue;
      }
      plan.updates.push(el.name);
      if (now.type !== el.type)
        plan.typeChanges.push({ name: el.name, from: now.type, to: el.type });
      if (
        el.type === "Consolidated" &&
        el.components &&
        el.components.length > 0
      ) {
        const keep = new Set(el.components.map((c) => c.name.toLowerCase()));
        const dropped = now.children.filter((c) => !keep.has(c.toLowerCase()));
        if (dropped.length > 0)
          plan.removals.push({ parent: el.name, children: dropped });
      }
    }
    return plan;
  }

  /**
   * Delete many elements of one hierarchy, one DELETE per element. Through
   * `$batch` when the server has it, otherwise one request per element.
   *
   * Never all-or-nothing: TM1's `$batch` is non-atomic, so each element gets
   * its own result and one missing name does not stop the rest. A systemic
   * failure (auth, transport) still aborts the call.
   *
   * Falling back after BatchUnsupportedError is safe: that error is only raised
   * before the first successful batch on the connection. Should a refused
   * envelope still have removed some elements, their per-request replay
   * reports NOT_FOUND instead of claiming a second delete.
   */
  async deleteMany(
    dimensionName: string,
    hierarchyName: string,
    elementNames: string[],
  ): Promise<ElementDeleteResult[]> {
    const pathOf = (name: string) =>
      `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(name)}')`;
    const failed = (elementName: string, e: TM1Error): ElementDeleteResult => ({
      elementName,
      deleted: false,
      error: { code: e.code, message: e.message },
    });
    const results = await this.execute(
      elementNames.map((name, i): BatchRequest => ({
        id: `d${i}`,
        method: "DELETE",
        path: pathOf(name),
      })),
    );
    const byIndex = new Map(results.map((r) => [Number(r.id.slice(1)), r]));
    return elementNames.map((elementName, i): ElementDeleteResult => {
      const r = byIndex.get(i);
      if (r === undefined)
        return failed(
          elementName,
          new TM1Error({
            code: TM1ErrorCode.TM1_ERROR,
            message: "No sub-response for this element in the $batch reply.",
          }),
        );
      return r.ok
        ? { elementName, deleted: true }
        : failed(elementName, r.error);
    });
  }

  /**
   * Scan element names in a hierarchy with a hard cap, paginating server-side.
   *
   * A single bulk Elements fetch can exceed V8's max string length on large
   * dimensions (response.text() buffers the whole body into one string), so
   * this probes the total via $count on the first page, then pages by
   * `pageSize` until either `maxScan` names are collected or the hierarchy is
   * exhausted. Callers learn the true `total` and whether the scan was
   * `truncated` — never a silent skip. Owns the V8-string-limit workaround so
   * tools don't reimplement raw OData paging.
   *
   * `opts.filter` narrows the scan to names matching an OData predicate, and
   * changes what the numbers mean: the server then evaluates every element and
   * returns only the matches, so `scanned` becomes the hierarchy total (the
   * server checked all of it) and `truncated` reports a capped MATCH set
   * rather than a partial walk. That is the difference between an audit that
   * examines the first 100k names and one that examines the dimension —
   * see src/lib/naming/odata-filter.ts.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name&$orderby=Name
   */
  async scanElementNames(
    dimensionName: string,
    hierarchyName: string,
    opts: {
      pageSize: number;
      maxScan: number;
      filter?: string;
      /**
       * Hierarchy size, when the caller already knows it. With a filter the
       * response counts MATCHES, so the scope figure would otherwise cost an
       * extra request per hierarchy — and the dimension listing can carry it
       * for free via a nested $count.
       */
      scopeTotal?: number;
    },
  ): Promise<{
    names: string[];
    total: number;
    scanned: number;
    truncated: boolean;
  }> {
    const { pageSize, maxScan, filter, scopeTotal } = opts;
    const hierarchyPath = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')`;
    // $orderby is mandatory with $skip — see odata-page.ts.
    const basePath =
      `${hierarchyPath}/Elements?$select=Name&$orderby=Name&$top=${pageSize}` +
      (filter ? `&$filter=${encodeURIComponent(filter)}` : "");

    // First page carries $count=true so we learn the total in one round-trip
    // without the /$count endpoint (TM1 v11 returns text/plain there and
    // rejects the Accept: application/json the shared HTTP client sends).
    const firstPage = await this.http.request<{
      "@odata.count"?: number;
      value: Array<{ Name: string }>;
    }>("GET", `${basePath}&$skip=0&$count=true`);

    const total = firstPage["@odata.count"] ?? firstPage.value.length;
    const scanLimit = Math.min(total, maxScan);
    const names: string[] = [];

    const firstSliceEnd = Math.min(firstPage.value.length, scanLimit);
    for (let i = 0; i < firstSliceEnd; i++) {
      names.push(firstPage.value[i]!.Name);
    }
    let skip = firstPage.value.length;
    let lastPageSize = firstPage.value.length;
    while (lastPageSize === pageSize && names.length < scanLimit) {
      const page = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        `${basePath}&$skip=${skip}`,
      );
      const remaining = scanLimit - names.length;
      const sliceEnd = Math.min(page.value.length, remaining);
      for (let i = 0; i < sliceEnd; i++) {
        names.push(page.value[i]!.Name);
      }
      lastPageSize = page.value.length;
      skip += page.value.length;
    }

    if (filter === undefined) {
      return {
        names,
        total,
        scanned: names.length,
        truncated: total > maxScan,
      };
    }

    // With a filter, `total` above counted the MATCHES. The caller still wants
    // to report how large the hierarchy was; when it already knows, that costs
    // nothing, otherwise one 145-byte probe.
    let inScope = scopeTotal;
    if (inScope === undefined) {
      const scopeProbe = await this.http.request<{ "@odata.count"?: number }>(
        "GET",
        `${hierarchyPath}/Elements?$select=Name&$top=0&$count=true`,
      );
      inScope = scopeProbe["@odata.count"] ?? total;
    }
    return {
      names,
      total: inScope,
      scanned: inScope,
      truncated: total > maxScan,
    };
  }

  /**
   * Type of one element, or null when the hierarchy has no such element.
   * Keyed lookup, so TM1 applies its own case- and space-insensitive name
   * matching and answers with the stored spelling.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements('{name}')?$select=Name,Type
   */
  async getType(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
  ): Promise<{ name: string; type: string } | null> {
    try {
      const e = await this.http.request<{
        Name: string;
        Type: number | string;
      }>(
        "GET",
        `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(elementName)}')?$select=Name,Type`,
      );
      return { name: e.Name, type: normalizeElementType(e.Type) };
    } catch (err) {
      if (err instanceof TM1Error && err.code === TM1ErrorCode.NOT_FOUND) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Which of `names` are consolidated (Type 3) in this hierarchy.
   *
   * One filtered request per chunk of names rather than a GET per element:
   * the server evaluates `Type eq 3 and (Name eq ...)` and answers with the
   * hits only, so the response is bounded by the consolidations among the
   * names asked about, never by the size of the hierarchy.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name&$filter=...
   */
  async consolidatedAmong(
    dimensionName: string,
    hierarchyName: string,
    names: string[],
  ): Promise<string[]> {
    const hits: string[] = [];
    for (let i = 0; i < names.length; i += CONSOLIDATED_PROBE_CHUNK) {
      const clause = names
        .slice(i, i + CONSOLIDATED_PROBE_CHUNK)
        .map((n) => `Name eq '${escapeOdataLiteral(n)}'`)
        .join(" or ");
      const filter = encodeURIComponent(`Type eq 3 and (${clause})`);
      const page = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements?$select=Name&$filter=${filter}`,
      );
      for (const e of page.value) hits.push(e.Name);
    }
    return hits;
  }

  /**
   * Bulk upsert elements into a hierarchy. Four passes so that leaves exist
   * before consolidations reference them: pass 1 creates/upserts every element
   * (type PATCH when an existing element's type differs), pass 2 sets
   * Components for Consolidated elements, pass 3 sets the edge weights.
   * POST/PATCH /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements(...)
   *
   * Every pass goes through `execute`: one `$batch` envelope per chunk when the
   * server has `$batch`, one request per call otherwise. Both give the same
   * result and the same throw-on-any-failure contract; only the number of HTTP
   * calls differs.
   */
  async bulkUpsert(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<{
    typeChanges: Array<{ name: string; from: string; to: string }>;
  }> {
    const baseUrl = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements`;
    // Correlate by element INDEX, not name: names are caller-supplied and could
    // repeat, which would collapse two sub-responses onto one id.
    const idOf = (i: number): string => `e${i}`;
    const indexOf = (id: string): number => Number(id.slice(1));

    // Pass 1a — create every element. TM1 runs the requests in payload order and
    // continues past failures, so one result comes back per element.
    //
    // This is the only call that can fall back to one-request-at-a-time. `execute`
    // falls back only on BatchUnsupportedError, which BatchService raises only
    // before the first successful batch on the connection, and this is the first
    // call of the method. So a fallback replays only creates: an element an
    // aborted envelope already created takes the "already exists" branch, sees
    // the type it was created with, and patches nothing.
    //
    // The destructive passes never run inside that window. Pass 1c (Type PATCH)
    // and pass 2 (Components) start only after pass 1a has returned, and if that
    // went through $batch the connection is now marked supported, which turns
    // the fallback off for good. A batch that fails after that (flaky gateway
    // mid-chunk) propagates as a real error instead, because replaying an
    // already-applied Type PATCH would re-probe, see the new type, and report no
    // typeChange for a conversion that did discard leaf values.
    //
    // tests/unit/batch-fallback-safety.test.ts pins both halves.
    const created = await this.execute(
      elements.map((el, i): BatchRequest => ({
        id: idOf(i),
        method: "POST",
        path: baseUrl,
        body: { Name: el.name, Type: el.type },
      })),
    );

    // Split the failures: "already exists" is the upsert path, anything else is
    // a genuine error that must abort the whole op. Keep element order so the
    // thrown error is the first failure in element order, not the first to be
    // noticed.
    const existing: number[] = [];
    for (const r of created) {
      if (r.ok) continue;
      const i = indexOf(r.id);
      if (isAlreadyExists(r.error)) existing.push(i);
      else throw r.error;
    }

    // Pass 1b — read the current Type of the elements that already existed, so
    // a type change can be reported (and skipped when it is a no-op). A failed
    // probe means "type unreadable" and falls through to the unconditional
    // PATCH below.
    const probed = await this.execute(
      existing.map((i): BatchRequest => ({
        id: idOf(i),
        method: "GET",
        path: `${baseUrl}('${odataKey(elements[i]!.name)}')?$select=Type`,
      })),
    );
    const typeById = new Map<number, string | null>();
    for (const r of probed) {
      // A transport/auth outage must NOT collapse into "type unreadable": that
      // would silently PATCH the type below and discard the element's leaf cell
      // values on a network blip or an expired session — and report nothing in
      // typeChanges, because an unreadable prior type yields no entry. Only a
      // genuine, non-systemic failure (e.g. NOT_FOUND) may degrade to null.
      if (!r.ok) rethrowIfSystemic(r.error);
      const raw = r.ok
        ? (r.body as { Type?: number | string } | null)?.Type
        : undefined;
      typeById.set(
        indexOf(r.id),
        raw === undefined || raw === null ? null : normalizeElementType(raw),
      );
    }

    // Pass 1c — patch the types that actually differ, plus the unreadable ones.
    const typeChanges: Array<{ name: string; from: string; to: string }> = [];
    const patches: BatchRequest[] = [];
    for (const i of existing) {
      const el = elements[i]!;
      const from = typeById.get(i) ?? null;
      if (from !== null && from === el.type) continue;
      patches.push({
        id: idOf(i),
        method: "PATCH",
        path: `${baseUrl}('${odataKey(el.name)}')`,
        body: { Type: el.type },
      });
      // A Numeric->Consolidated / Numeric->String conversion discards the
      // element's leaf cell values, so report it rather than let it happen
      // silently. An unreadable prior type yields no entry.
      if (from !== null) typeChanges.push({ name: el.name, from, to: el.type });
    }
    throwFirstFailure(await this.execute(patches), indexOf);

    // Pass barrier: every leaf write above has settled before any consolidation
    // references it via Components. Pass 1 already threw on any hard failure.
    //
    // Pass 2 — PATCH {Components:[...]} is FULL-REPLACE, not append (verified
    // live vs TM1 v11). Consolidations with no/empty components are skipped, so
    // an upsert that omits components leaves existing children intact.
    const components: BatchRequest[] = [];
    for (const [i, el] of elements.entries()) {
      if (
        el.type !== "Consolidated" ||
        !el.components ||
        el.components.length === 0
      )
        continue;
      components.push({
        id: idOf(i),
        method: "PATCH",
        path: `${baseUrl}('${odataKey(el.name)}')`,
        body: {
          Components: el.components.map((c) => ({
            "@odata.id": `Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(c.name)}')`,
            Weight: c.weight,
          })),
        },
      });
    }
    throwFirstFailure(await this.execute(components), indexOf);

    // Pass 3 — the weights. TM1 accepts `Weight` inside the Components link
    // above and ignores it: every edge it creates has weight 1 (measured). The
    // weight lives on the Edge entity and has to be PATCHed once the link
    // exists, which is only true after pass 2. Only deviating weights cost a
    // request.
    //
    // Own id space: one element can own several edges, and a repeated id makes
    // v12 reject the whole envelope. `edgeOwner` maps each request back to the
    // element that asked for it, so a failure still names the right one.
    const edges: BatchRequest[] = [];
    const edgeOwner: number[] = [];
    for (const [i, el] of elements.entries()) {
      if (el.type !== "Consolidated" || !el.components) continue;
      for (const c of el.components) {
        if (c.weight === undefined || c.weight === 1) continue;
        edges.push({
          id: `e${edgeOwner.length}`,
          method: "PATCH",
          path: `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Edges(ParentName='${odataKey(el.name)}',ComponentName='${odataKey(c.name)}')`,
          body: { Weight: c.weight },
        });
        edgeOwner.push(i);
      }
    }
    if (edges.length > 0) {
      throwFirstFailure(
        await this.execute(edges),
        (id) => edgeOwner[Number(id.slice(1))] ?? Number.POSITIVE_INFINITY,
      );
    }

    return { typeChanges };
  }

  /**
   * List element-attribute definitions for a hierarchy.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/ElementAttributes
   */
  async listAttributes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: "Numeric" | "String" | "Alias" }>> {
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/ElementAttributes`;
    const response = await this.http.request<{
      value: Array<{ Name: string; Type: string }>;
    }>("GET", path);
    return response.value.map((a) => ({
      name: a.Name,
      type: a.Type as "Numeric" | "String" | "Alias",
    }));
  }

  /**
   * Case-insensitive substring search over element names, Alias attribute
   * values and the String attributes named in `stringAttributes`. OData cannot do this: `$filter`
   * on `Attributes/X` fails with error 278 ("did not resolve to a value of
   * type string") on v11, so the match runs as an MDX FILTER on the server.
   * `Cardinality` counts the whole match set while `Tuples($top)` caps what
   * comes back, so `total` is exact without fetching every match.
   *
   * Every searched attribute costs one `Properties()` per element. Measured
   * on 160,666 elements: name plus alias 0.65 s, +0.07 s per String
   * attribute; the VS Code extension saw 0.9 s for one attribute and 2.3 s
   * for all on 1.63 million. Hence Alias only by default, String attributes
   * on request; names that are not String attributes are ignored.
   *
   * POST /api/v1/ExecuteMDXSetExpression
   */
  async searchElements(
    dimensionName: string,
    hierarchyName: string,
    searchTerm: string,
    topN: number,
    stringAttributes: readonly string[] = [],
  ): Promise<{
    total: number;
    elements: Array<{
      name: string;
      type: string;
      level: number;
      matchedOn: string;
      matchedValue: string;
    }>;
  }> {
    const attrs = (await this.listAttributes(dimensionName, hierarchyName))
      .filter(
        (a) =>
          a.type === "Alias" ||
          (a.type === "String" && stringAttributes.includes(a.name)),
      )
      .map((a) => a.name);
    const term = searchTerm.toLowerCase();
    const member = `[${escapeMdxName(dimensionName)}].[${escapeMdxName(hierarchyName)}].CurrentMember`;
    // MDX string literals escape `"` by doubling it.
    const lit = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const tests = [
      `${member}.Name`,
      ...attrs.map((a) => `${member}.Properties(${lit(a)})`),
    ].map((expr) => `INSTR(1, LCASE(${expr}), ${lit(term)}) > 0`);
    const mdx = `{FILTER(TM1SUBSETALL([${escapeMdxName(dimensionName)}].[${escapeMdxName(hierarchyName)}]), ${tests.join(" OR ")})}`;
    const response = await this.http.request<{
      Cardinality: number;
      Tuples: Array<{
        Members: Array<{
          Name: string;
          Attributes?: Record<string, unknown>;
          Element: { Type: string; Level: number };
        }>;
      }>;
    }>(
      "POST",
      `/api/v1/ExecuteMDXSetExpression?$select=Cardinality&$expand=Tuples($top=${topN};$expand=Members($select=Name,Attributes;$expand=Element($select=Type,Level)))`,
      { MDX: mdx },
    );
    const elements = response.Tuples.map((t) => {
      const m = t.Members[0]!;
      const base = {
        name: m.Name,
        type: m.Element.Type,
        level: m.Element.Level,
      };
      if (m.Name.toLowerCase().includes(term)) {
        return { ...base, matchedOn: "Name", matchedValue: m.Name };
      }
      // Attributes carries only non-empty values; the server already
      // proved one of them matches.
      const hit = attrs.find((a) =>
        String(m.Attributes?.[a] ?? "")
          .toLowerCase()
          .includes(term),
      );
      return {
        ...base,
        matchedOn: hit ?? "Name",
        matchedValue: hit ? String(m.Attributes![hit]) : m.Name,
      };
    });
    return { total: response.Cardinality, elements };
  }

  /**
   * Attribute values for a window of elements — every element of the
   * dimension's default hierarchy, name-sorted, `limit` at a time. One MDX
   * against `}ElementAttributes_{Dim}` with the window pushed into the row set
   * (`SUBSET(TM1SORT(TM1SUBSETALL(...)))`), so the query text stays short no
   * matter how many elements a page holds — TM1's request entity limit can be
   * as low as 32 KB. `total` comes from `$count` on the Elements collection.
   *
   * `attributeNames` narrows the columns; omitted, every attribute is read.
   */
  async getAttributeValuesPage(
    dimensionName: string,
    opts: { offset: number; limit: number; attributeNames?: string[] },
  ): Promise<{
    total: number;
    items: Array<{ elementName: string; values: Record<string, CellValue> }>;
  }> {
    const countPath = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(dimensionName)}')/Elements?$select=Name&$top=1&$count=true`;
    const counted = await this.http.request<{ "@odata.count"?: number }>(
      "GET",
      countPath,
    );
    const total = counted["@odata.count"] ?? 0;
    if (opts.limit === 0 || opts.offset >= total) return { total, items: [] };

    const esc = (s: string): string => s.replace(/]/g, "]]");
    const dim = esc(dimensionName);
    const attrDim = `[}ElementAttributes_${dim}].[}ElementAttributes_${dim}]`;
    const columns =
      opts.attributeNames && opts.attributeNames.length > 0
        ? `{${opts.attributeNames.map((a) => `${attrDim}.[${esc(a)}]`).join(", ")}}`
        : `{TM1SUBSETALL(${attrDim})}`;
    const mdx =
      `SELECT ${columns} ON COLUMNS, ` +
      `SUBSET(TM1SORT({TM1SUBSETALL([${dim}].[${dim}])}, ASC), ${opts.offset}, ${opts.limit}) ON ROWS ` +
      `FROM [}ElementAttributes_${dim}]`;
    const result = await this.cells.executeMdx(mdx);
    const attrs = (result.axes[0]?.tuples ?? []).map(
      (t) => t.members[0]?.name ?? "",
    );
    const rows = result.axes[1]?.tuples ?? [];
    // Cells are row-major: cell (r, c) sits at r * columns + c.
    const items = rows.map((t, r) => {
      const values: Record<string, CellValue> = {};
      attrs.forEach((a, c) => {
        values[a] = result.cells[r * attrs.length + c]?.value ?? null;
      });
      return { elementName: t.members[0]?.name ?? "", values };
    });
    return { total, items };
  }

  /**
   * Set a single attribute value. See {@link updateAttributeValues}.
   */
  async updateAttributeValue(
    dimensionName: string,
    elementName: string,
    attributeName: string,
    value: number | string,
    hierarchyName: string = dimensionName,
  ): Promise<void> {
    await this.updateAttributeValues(
      dimensionName,
      [{ elementName, attributeName, value }],
      hierarchyName,
    );
  }

  /**
   * Set attribute values by writing to the `}ElementAttributes_{Dim}` control
   * cube — every update in ONE cellset write (CellService.writeCells).
   *
   * The attributes are looked up once. TM1 matches attribute names ignoring
   * case and spaces, so the lookup compares the same way; an unknown attribute
   * is NOT_FOUND, raised before anything is written — without the check TM1
   * answers with a raw MDX syntax error (no attribute at all means no
   * attribute cube). Values are coerced to the attribute's type: a Numeric
   * attribute takes a number or a numeric string (`"12.5"`), String and Alias
   * attributes take the value as text; a non-numeric value for a Numeric
   * attribute is a VALIDATION_ERROR that names it.
   *
   * Prefer TI processes (CellPutS / AttrPutS) for reproducible deployments;
   * this REST-direct path is for ad-hoc / debugging use.
   */
  async updateAttributeValues(
    dimensionName: string,
    updates: Array<{
      elementName: string;
      attributeName: string;
      value: number | string;
    }>,
    hierarchyName: string = dimensionName,
  ): Promise<void> {
    if (updates.length === 0) return;
    const attrs = await this.listAttributes(dimensionName, hierarchyName);
    const key = (n: string) => n.replace(/\s/g, "").toLowerCase();
    const types = new Map(attrs.map((a) => [key(a.name), a.type]));
    const esc = (s: string): string => s.replace(/]/g, "]]");
    const cells = updates.map((u) => {
      const type = types.get(key(u.attributeName));
      if (type === undefined) {
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message:
            attrs.length === 0
              ? `Dimension '${dimensionName}' has no attributes; create '${u.attributeName}' first with tm1_rest_write POST Dimensions('${dimensionName}')/Hierarchies('${dimensionName}')/ElementAttributes.`
              : `Attribute '${u.attributeName}' does not exist on dimension '${dimensionName}'. Existing: ${attrs.map((a) => a.name).join(", ")}.`,
        });
      }
      let value: number | string = String(u.value);
      if (type === "Numeric") {
        const n =
          typeof u.value === "number" ? u.value : Number(u.value.trim());
        if (u.value === "" || !Number.isFinite(n)) {
          throw new TM1Error({
            code: TM1ErrorCode.VALIDATION_ERROR,
            message: `Attribute '${u.attributeName}' is Numeric; '${String(u.value)}' (element '${u.elementName}') is not a number.`,
          });
        }
        value = n;
      }
      // Qualified for the same reason as getAttributeValues; writeCells passes
      // a `[Dim].[Hier].[Elem]` coordinate through unchanged.
      const member = `[${esc(dimensionName)}].[${esc(hierarchyName)}].[${esc(u.elementName)}]`;
      return { elements: [member, u.attributeName], value };
    });
    await this.cells.writeCells(
      `}ElementAttributes_${dimensionName}`,
      [dimensionName, `}ElementAttributes_${dimensionName}`],
      cells,
    );
  }

  /**
   * Does an element resolve in a hierarchy the way TI would resolve it?
   * The key lookup is TM1's own name resolution: case- and space-insensitive,
   * and it accepts an alias (verified on 11.8.03500: 'northamerica' and the
   * alias 'NA' both resolve 'North America'). 404 → false; anything else,
   * including a denial, is rethrown — "you may not look" is not "missing".
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements('{e}')?$select=Name
   */
  async exists(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
  ): Promise<boolean> {
    try {
      await this.http.request<{ Name: string }>(
        "GET",
        `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(elementName)}')?$select=Name`,
      );
      return true;
    } catch (e) {
      if (e instanceof TM1Error && e.code === TM1ErrorCode.NOT_FOUND)
        return false;
      throw e;
    }
  }
}
