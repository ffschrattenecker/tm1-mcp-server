import { describe, it, expect } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import {
  BatchService,
  BatchUnsupportedError,
} from "../../src/tm1-client/services/batch-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { CellService } from "../../src/tm1-client/services/cell-service.js";
import type { ElementCreate } from "../../src/types.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// bulkUpsert prefers OData $batch and falls back to a per-request fan-out with
// bounded concurrency WITHIN each pass. Both paths must keep the pass barrier —
// every leaf write (pass 1) completes before any consolidation Components write
// (pass 2), because a consolidation references its leaves — report typeChanges
// in element order, and reject the whole op on a genuine per-element failure
// before pass 2. The shared contract runs against both paths; the $batch-only
// cases and the fallback rules follow.

// One request as the service issued it: a per-request HTTP call, or one
// sub-request of a $batch envelope (its url is relative to /api/v1/).
type Req = { id?: string; method: string; url: string; body?: unknown };

interface HarnessOpts {
  /** Hard-fail a request with a TM1 error response. */
  fail?: (r: Req) => { status: number; message: string } | undefined;
  /** Elements that already exist: POST answers "already exists", the type probe answers this type. */
  existing?: Record<string, string>;
  /** Per-call latency (per-request path) so concurrent scheduling interleaves. */
  delayMs?: number;
}

interface Harness {
  svc: ElementService;
  /** Every request in the order it was issued. */
  requests: () => Req[];
}

const nameOf = (r: Req): string | undefined =>
  (r.body as { Name?: string } | undefined)?.Name ??
  /Elements\('([^']+)'\)/.exec(r.url)?.[1];

type Outcome =
  | { kind: "ok"; body?: unknown }
  | { kind: "exists" }
  | { kind: "error"; status: number; message: string };

function outcomeOf(r: Req, opts: HarnessOpts): Outcome {
  const failure = opts.fail?.(r);
  if (failure) return { kind: "error", ...failure };
  const name = nameOf(r);
  const type = name === undefined ? undefined : opts.existing?.[name];
  if (type !== undefined && r.method === "POST") return { kind: "exists" };
  if (type !== undefined && r.method === "GET") {
    return { kind: "ok", body: { Type: type } };
  }
  return { kind: "ok" };
}

const cells = {} as unknown as CellService;

// Per-request path: no BatchService wired. "Already exists" arrives as a 409.
function perRequestHarness(opts: HarnessOpts = {}): Harness {
  const requests: Req[] = [];
  const http = contractCheckedHttp({
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const r = { method, url: path, body };
      requests.push(r);
      if (opts.delayMs)
        await new Promise((res) => setTimeout(res, opts.delayMs));
      const o = outcomeOf(r, opts);
      if (o.kind === "exists") {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "An element with that name already exists",
          httpStatus: 409,
        });
      }
      if (o.kind === "error") {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: o.message,
          httpStatus: o.status,
        });
      }
      return o.body as T;
    },
  } as unknown as TM1HttpClient);
  return { svc: new ElementService(http, cells), requests: () => requests };
}

type SubRequest = { id: string; method: string; url: string; body?: unknown };
type SubResponse = { id: string; status: number; body?: unknown };

interface BatchFakeOpts {
  /** Per-sub-request outcome. Return a status (+body) or undefined for 200. */
  onSub?: (r: SubRequest) => SubResponse | undefined;
  /** Fail the whole envelope. */
  throwOnBatch?: Error;
}

function makeBatchService(opts: BatchFakeOpts = {}): {
  svc: ElementService;
  batches: SubRequest[][];
  perRequest: Array<{ method: string; path: string }>;
} {
  const batches: SubRequest[][] = [];
  const perRequest: Array<{ method: string; path: string }> = [];
  const http = contractCheckedHttp({
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path === "/api/v1/$batch") {
        if (opts.throwOnBatch) throw opts.throwOnBatch;
        const requests = (body as { requests: SubRequest[] }).requests;
        batches.push(requests);
        return {
          responses: requests.map(
            (r) => opts.onSub?.(r) ?? { id: r.id, status: 200, body: {} },
          ),
        } as T;
      }
      perRequest.push({ method, path });
      return undefined as T;
    },
  } as unknown as TM1HttpClient);
  const batch = new BatchService(http);
  return { svc: new ElementService(http, cells, batch), batches, perRequest };
}

// v11.8 answers a create of an existing element with 400 + this message.
const alreadyExists = (id: string): SubResponse => ({
  id,
  status: 400,
  body: {
    error: {
      message:
        'An element with name "x" already exists. Failed to create element.',
    },
  },
});

// $batch path over the shared outcome model.
function batchHarness(opts: HarnessOpts = {}): Harness {
  const { svc, batches } = makeBatchService({
    onSub: (r) => {
      const o = outcomeOf(r, opts);
      if (o.kind === "exists") return alreadyExists(r.id);
      if (o.kind === "error") {
        return {
          id: r.id,
          status: o.status,
          body: { error: { message: o.message } },
        };
      }
      return { id: r.id, status: 200, body: o.body ?? {} };
    },
  });
  return { svc, requests: () => batches.flat() };
}

const isComponentsPatch = (r: Req): boolean =>
  r.method === "PATCH" &&
  !!(r.body as { Components?: unknown } | undefined)?.Components;

const isEdgePatch = (r: Req): boolean =>
  r.method === "PATCH" && r.url.includes("/Edges(");

describe.each([
  { path: "per-request", make: perRequestHarness },
  { path: "$batch", make: batchHarness },
])("ElementService.bulkUpsert ($path) — shared contract", ({ make }) => {
  it("runs all leaf writes (pass 1) before any consolidation Components write (pass 2)", async () => {
    const elements: ElementCreate[] = [
      { name: "L1", type: "Numeric" },
      { name: "L2", type: "Numeric" },
      { name: "L3", type: "String" },
      {
        name: "C1",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
      {
        name: "C2",
        type: "Consolidated",
        components: [{ name: "L2", weight: 1 }],
      },
    ];
    // Stagger latency so a broken barrier (pass 2 racing pass 1) surfaces as an
    // interleave rather than staying hidden behind deterministic ordering.
    const h = make({ delayMs: 5 });
    await h.svc.bulkUpsert("Dim", "Dim", elements);

    const reqs = h.requests();
    const lastPost = reqs.reduce(
      (acc, r, i) => (r.method === "POST" ? i : acc),
      -1,
    );
    const firstComponents = reqs.findIndex(isComponentsPatch);
    expect(lastPost).toBeGreaterThanOrEqual(0);
    expect(firstComponents).toBeGreaterThanOrEqual(0);
    // Barrier: no Components-PATCH may precede any leaf/consolidation POST.
    expect(firstComponents).toBeGreaterThan(lastPost);

    expect(reqs.filter((r) => r.method === "POST")).toHaveLength(5);
    expect(reqs.filter(isComponentsPatch)).toHaveLength(2);
    // Components arrive as OData refs with their weights.
    expect(
      (reqs[firstComponents].body as { Components: unknown[] }).Components,
    ).toEqual([
      {
        "@odata.id": "Dimensions('Dim')/Hierarchies('Dim')/Elements('L1')",
        Weight: 1,
      },
    ]);
  });

  it("skips consolidations with no/empty components (no Components PATCH)", async () => {
    const h = make();
    await h.svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      { name: "C_empty", type: "Consolidated", components: [] },
      { name: "C_none", type: "Consolidated" },
    ]);
    expect(h.requests().filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("reports type changes in element order and patches only what differs", async () => {
    // E1/E2/E3 all exist. E1 String->Numeric (change), E2 same type (no write),
    // E3 Numeric->String (change). Concurrency must not scramble the order.
    const h = make({
      delayMs: 3,
      existing: { E1: "String", E2: "Numeric", E3: "Numeric" },
    });
    const { typeChanges } = await h.svc.bulkUpsert("Dim", "Dim", [
      { name: "E1", type: "Numeric" },
      { name: "E2", type: "Numeric" },
      { name: "E3", type: "String" },
    ]);

    expect(typeChanges).toEqual([
      { name: "E1", from: "String", to: "Numeric" },
      { name: "E3", from: "Numeric", to: "String" },
    ]);
    // E2 is untouched — no pointless write.
    const typePatches = h.requests().filter((r) => r.method === "PATCH");
    expect(typePatches.map((r) => r.url.replace(/^\/api\/v1\//, ""))).toEqual([
      "Dimensions('Dim')/Hierarchies('Dim')/Elements('E1')",
      "Dimensions('Dim')/Hierarchies('Dim')/Elements('E3')",
    ]);
  });

  it("rejects with the FIRST failure in element order, before pass 2", async () => {
    const h = make({
      fail: (r) => {
        const name = (r.body as { Name?: string } | undefined)?.Name;
        return name === "L2" || name === "L3"
          ? { status: 400, message: `Invalid element type ${name}` }
          : undefined;
      },
    });

    const err = await h.svc
      .bulkUpsert("Dim", "Dim", [
        { name: "L1", type: "Numeric" },
        { name: "L2", type: "Numeric" },
        { name: "L3", type: "Numeric" },
        {
          name: "C1",
          type: "Consolidated",
          components: [{ name: "L1", weight: 1 }],
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).message).toBe("Invalid element type L2");

    // Barrier held: a failed pass 1 aborts BEFORE any Components PATCH runs.
    expect(h.requests().some(isComponentsPatch)).toBe(false);
  });

  it("rejects when a Components PATCH fails", async () => {
    const h = make({
      fail: (r) =>
        isComponentsPatch(r)
          ? { status: 400, message: "bad component ref" }
          : undefined,
    });
    await expect(
      h.svc.bulkUpsert("Dim", "Dim", [
        { name: "L1", type: "Numeric" },
        {
          name: "C1",
          type: "Consolidated",
          components: [{ name: "L1", weight: 1 }],
        },
      ]),
    ).rejects.toMatchObject({ message: "bad component ref" });
  });
});

describe("ElementService.bulkUpsert — per-request path", () => {
  it("rethrows the leaf's own error unwrapped", async () => {
    const boom = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: "Invalid element type",
      httpStatus: 400,
    });
    const http = contractCheckedHttp({
      async request<T>(method: string, _path: string, body?: unknown) {
        if (method === "POST" && (body as { Name?: string }).Name === "L2") {
          throw boom;
        }
        return undefined as T;
      },
    } as unknown as TM1HttpClient);
    await expect(
      new ElementService(http, cells).bulkUpsert("Dim", "Dim", [
        { name: "L1", type: "Numeric" },
        { name: "L2", type: "Numeric" },
      ]),
    ).rejects.toBe(boom);
  });
});

// Consolidation weights. TM1 accepts `Weight` inside the Components link and
// ignores it — every edge it creates has weight 1 — so the deviating ones have
// to be PATCHed on the Edge entity afterwards. Measured on 11.8 via
// tm1_bulk_upsert_elements: a component asked for at -1 read back as +1, which
// silently inverts a netting consolidation.
describe.each([
  { path: "per-request", make: perRequestHarness },
  { path: "$batch", make: batchHarness },
])("ElementService.bulkUpsert ($path) — consolidation weights", ({ make }) => {
  const WEIGHTED: ElementCreate[] = [
    { name: "L1", type: "Numeric" },
    { name: "L2", type: "Numeric" },
    { name: "L3", type: "Numeric" },
    {
      name: "C1",
      type: "Consolidated",
      components: [
        { name: "L1", weight: 1 },
        { name: "L2", weight: -1 },
        { name: "L3", weight: 3 },
      ],
    },
  ];

  it("PATCHes the Edge for each weight that is not 1, after the edge exists", async () => {
    const h = make();
    await h.svc.bulkUpsert("Dim", "Dim", WEIGHTED);

    const reqs = h.requests();
    const edges = reqs.filter(isEdgePatch);
    expect(edges).toHaveLength(2);
    expect(edges.every((r) => r.url.includes("ParentName='C1'"))).toBe(true);
    expect(edges[0].url).toContain("ComponentName='L2'");
    expect(edges[1].url).toContain("ComponentName='L3'");
    expect(edges.map((r) => r.body)).toEqual([{ Weight: -1 }, { Weight: 3 }]);

    // Order: the edge has to exist before its weight can be set.
    const componentsAt = reqs.findIndex(isComponentsPatch);
    expect(componentsAt).toBeGreaterThanOrEqual(0);
    expect(reqs.findIndex(isEdgePatch)).toBeGreaterThan(componentsAt);
  });

  it("does not spend a request on the weights that are already 1", async () => {
    const h = make();
    await h.svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      {
        name: "C1",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
      {
        name: "C2",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
    ]);
    expect(h.requests().some(isEdgePatch)).toBe(false);
  });

  it("a rejected weight fails the whole upsert", async () => {
    const h = make({
      fail: (r) =>
        isEdgePatch(r) ? { status: 400, message: "nope" } : undefined,
    });
    await expect(h.svc.bulkUpsert("Dim", "Dim", WEIGHTED)).rejects.toThrow();
  });
});

describe("ElementService.bulkUpsert — $batch path", () => {
  it("creates every element in ONE batch instead of one call each", async () => {
    const { svc, batches, perRequest } = makeBatchService();
    const elements: ElementCreate[] = Array.from({ length: 50 }, (_, i) => ({
      name: `L${i}`,
      type: "Numeric",
    }));

    await svc.bulkUpsert("Dim", "Dim", elements);

    // No element ever goes out as its own HTTP request.
    expect(perRequest).toHaveLength(0);
    const creates = batches.flat().filter((r) => r.method === "POST");
    expect(creates).toHaveLength(50);
    expect(creates[0].url).toBe(
      "Dimensions('Dim')/Hierarchies('Dim')/Elements",
    );
    expect(creates[0].body).toEqual({ Name: "L0", Type: "Numeric" });
  });

  it("patches unconditionally, and reports no change, when the prior type is unreadable", async () => {
    const { svc, batches } = makeBatchService({
      onSub: (r) => {
        if (r.method === "POST") return alreadyExists(r.id);
        if (r.method === "GET") {
          return {
            id: r.id,
            status: 404,
            body: { error: { message: "not found" } },
          };
        }
        return undefined;
      },
    });
    const { typeChanges } = await svc.bulkUpsert("Dim", "Dim", [
      { name: "E1", type: "Numeric" },
    ]);
    expect(typeChanges).toEqual([]);
    const patches = batches.flat().filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ Type: "Numeric" });
  });

  // The type probe decides whether the Type gets PATCHed. A systemic failure
  // (expired session, socket death) must NOT read as "type unreadable": that
  // would rewrite the type and discard the element's leaf cell values on a
  // blip, and report nothing in typeChanges. Mirrors the per-request guard.
  it("propagates a systemic probe failure instead of patching the type", async () => {
    const { svc, batches } = makeBatchService({
      onSub: (r) => {
        if (r.method === "POST") return alreadyExists(r.id);
        if (r.method === "GET") {
          return {
            id: r.id,
            status: 401,
            body: { error: { message: "Authentication failed" } },
          };
        }
        return undefined;
      },
    });

    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "E1", type: "String" }]),
    ).rejects.toMatchObject({ code: TM1ErrorCode.AUTH_FAILED });
    // Nothing was rewritten.
    expect(batches.flat().filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  // "already exists" is matched on the message TEXT, so the sub-response error
  // must carry that text even when the body is not the familiar
  // {error:{message}} envelope — otherwise a re-upsert throws instead of
  // updating.
  it("still recognises already-exists when the error body shape is unfamiliar", async () => {
    const { svc } = makeBatchService({
      onSub: (r) => {
        if (r.method === "POST") {
          return {
            id: r.id,
            status: 400,
            body: { Message: 'An element with name "E1" already exists.' },
          };
        }
        if (r.method === "GET")
          return { id: r.id, status: 200, body: { Type: "Numeric" } };
        return undefined;
      },
    });

    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "E1", type: "Numeric" }]),
    ).resolves.toEqual({
      typeChanges: [],
    });
  });

  it("uses element index (not name) to correlate, so duplicate names cannot collide", async () => {
    const { svc, batches } = makeBatchService();
    await svc.bulkUpsert("Dim", "Dim", [
      { name: "DUP", type: "Numeric" },
      { name: "DUP", type: "Numeric" },
    ]);
    const ids = batches.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The one weight rule only the batch path can get wrong: two edges under one
  // element must not reuse an id. v12 rejects an envelope with duplicate ids
  // outright.
  it("sends the edge weights as their own batch, with unique ids, after the Components batch", async () => {
    const { svc, batches } = makeBatchService();
    await svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      { name: "L2", type: "Numeric" },
      {
        name: "C1",
        type: "Consolidated",
        components: [
          { name: "L1", weight: -1 },
          { name: "L2", weight: 3 },
        ],
      },
    ]);

    const edgeBatch = batches.find((reqs) => reqs.some(isEdgePatch));
    expect(edgeBatch).toBeDefined();
    expect(edgeBatch).toHaveLength(2);
    expect(new Set(edgeBatch!.map((r) => r.id)).size).toBe(2);
    const componentsBatchIdx = batches.findIndex((reqs) =>
      reqs.some(isComponentsPatch),
    );
    expect(batches.indexOf(edgeBatch!)).toBeGreaterThan(componentsBatchIdx);
  });
});

describe("ElementService.bulkUpsert — fallback to the per-request path", () => {
  it("falls back when the server has no $batch endpoint", async () => {
    const { svc, perRequest } = makeBatchService({
      throwOnBatch: new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: "no $batch here",
        httpStatus: 404,
      }),
    });

    const { typeChanges } = await svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      {
        name: "C1",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
    ]);

    expect(typeChanges).toEqual([]);
    // The old path ran: one POST per element plus the Components PATCH.
    expect(perRequest.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(perRequest.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("does not re-probe $batch on a later bulkUpsert once it is known unsupported", async () => {
    let batchAttempts = 0;
    const http = contractCheckedHttp({
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === "/api/v1/$batch") {
          batchAttempts++;
          throw new TM1Error({
            code: TM1ErrorCode.NOT_FOUND,
            message: "nope",
            httpStatus: 404,
          });
        }
        return undefined as T;
      },
    } as unknown as TM1HttpClient);
    const svc = new ElementService(http, cells, new BatchService(http));

    await svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]);
    await svc.bulkUpsert("Dim", "Dim", [{ name: "L2", type: "Numeric" }]);
    expect(batchAttempts).toBe(1);
  });

  it("does NOT fall back on a systemic transport failure (no silent re-drive of writes)", async () => {
    const boom = new TM1Error({
      code: TM1ErrorCode.CONNECTION_FAILED,
      message: "socket died",
    });
    const { svc, perRequest } = makeBatchService({ throwOnBatch: boom });
    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]),
    ).rejects.toBe(boom);
    expect(perRequest).toHaveLength(0);
  });

  it("does NOT fall back on a sub-request failure — that is a real element error", async () => {
    const { svc, perRequest } = makeBatchService({
      onSub: (r) => ({
        id: r.id,
        status: 400,
        body: { error: { message: "Invalid element type" } },
      }),
    });
    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]),
    ).rejects.toMatchObject({ message: "Invalid element type" });
    expect(perRequest).toHaveLength(0);
  });

  it("uses the per-request path when no BatchService is wired", async () => {
    const calls: string[] = [];
    const http = contractCheckedHttp({
      async request<T>(method: string, path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        return undefined as T;
      },
    } as unknown as TM1HttpClient);
    const svc = new ElementService(http, cells);
    await svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]);
    expect(calls.some((c) => c.includes("$batch"))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("BatchUnsupportedError never escapes bulkUpsert", async () => {
    const { svc } = makeBatchService({
      throwOnBatch: new BatchUnsupportedError("synthetic"),
    });
    // A BatchUnsupportedError thrown by the transport stub is not a TM1Error, so
    // it propagates out of BatchService untouched — bulkUpsert must still treat
    // it as "no batch" and complete via the fallback.
    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]),
    ).resolves.toEqual({
      typeChanges: [],
    });
  });
});
