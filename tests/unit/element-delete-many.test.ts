import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import {
  BatchUnsupportedError,
  type BatchRequest,
  type BatchSubResult,
} from "../../src/tm1-client/services/batch-service.js";
import { registerDeleteElements } from "../../src/tools/dimension-management/delete-elements.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";

type Ctor = ConstructorParameters<typeof ElementService>;

const notFound = (name: string) =>
  new TM1Error({
    code: TM1ErrorCode.NOT_FOUND,
    message: `Element '${name}' not found`,
    httpStatus: 404,
  });

// Elements that exist; anything else answers 404.
const EXISTING = new Set(["A", "B", "C"]);
const nameOf = (path: string) => /Elements\('([^']*)'\)$/.exec(path)![1];

function batchFake(seen: BatchRequest[][]) {
  return {
    isKnownUnsupported: false,
    execute: async (reqs: BatchRequest[]): Promise<BatchSubResult[]> => {
      seen.push(reqs);
      return reqs.map((r) =>
        EXISTING.has(nameOf(r.path))
          ? { id: r.id, status: 204, ok: true, body: null }
          : {
              id: r.id,
              status: 404,
              ok: false,
              error: notFound(nameOf(r.path)),
            },
      );
    },
  };
}

function httpFake(paths: string[], systemic = false) {
  return {
    request: async (method: string, path: string) => {
      paths.push(`${method} ${path}`);
      if (systemic)
        throw new TM1Error({
          code: TM1ErrorCode.AUTH_FAILED,
          message: "session expired",
        });
      if (!EXISTING.has(nameOf(path))) throw notFound(nameOf(path));
    },
  };
}

describe("ElementService.deleteMany", () => {
  it("sends one DELETE sub-request per element and reports each outcome", async () => {
    const seen: BatchRequest[][] = [];
    const svc = new ElementService(
      httpFake([]) as unknown as Ctor[0],
      {} as Ctor[1],
      batchFake(seen) as unknown as Ctor[2],
    );
    const out = await svc.deleteMany("Region", "Region", ["A", "X", "C"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((r) => r.method)).toEqual([
      "DELETE",
      "DELETE",
      "DELETE",
    ]);
    expect(out).toEqual([
      { elementName: "A", deleted: true },
      {
        elementName: "X",
        deleted: false,
        error: { code: "NOT_FOUND", message: "Element 'X' not found" },
      },
      { elementName: "C", deleted: true },
    ]);
  });

  it("falls back to per-request deletes when the server has no $batch", async () => {
    const paths: string[] = [];
    const svc = new ElementService(
      httpFake(paths) as unknown as Ctor[0],
      {} as Ctor[1],
      {
        isKnownUnsupported: false,
        execute: async () => {
          throw new BatchUnsupportedError("404 on $batch");
        },
      } as unknown as Ctor[2],
    );
    const out = await svc.deleteMany("Region", "Region", ["A", "X"]);
    expect(paths).toHaveLength(2);
    expect(out.map((r) => r.deleted)).toEqual([true, false]);
  });

  it("aborts on a systemic error instead of reporting it per element", async () => {
    const svc = new ElementService(
      httpFake([], true) as unknown as Ctor[0],
      {} as Ctor[1],
    );
    await expect(svc.deleteMany("Region", "Region", ["A"])).rejects.toThrow(
      /session expired/,
    );
  });
});

describe("tm1_delete_elements", () => {
  function call(args: Record<string, unknown>, client: unknown) {
    let h: ((a: unknown) => Promise<unknown>) | null = null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    registerDeleteElements(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      client as TM1Client,
    );
    return h!(parser!.parse(args)) as Promise<{
      structuredContent: Record<string, unknown>;
    }>;
  }

  it("confirms on the dimension name and summarises the failures", async () => {
    const calls: unknown[][] = [];
    const client = {
      elements: {
        deleteMany: async (...a: unknown[]) => {
          calls.push(a);
          return [
            { elementName: "A", deleted: true },
            {
              elementName: "X",
              deleted: false,
              error: { code: "NOT_FOUND", message: "gone" },
            },
          ];
        },
      },
    };
    const res = await call(
      { dimensionName: "Region", elementNames: ["A", "X"], confirm: "Region" },
      client,
    );
    expect(calls).toEqual([["Region", "Region", ["A", "X"]]]);
    expect(res.structuredContent).toMatchObject({
      success: false,
      deleted: 1,
      failed: 1,
      failures: [{ elementName: "X" }],
    });
  });

  it("rejects a confirm that is not the dimension name", async () => {
    await expect(
      call(
        { dimensionName: "Region", elementNames: ["A"], confirm: "A" },
        { elements: {} },
      ),
    ).rejects.toThrow(/confirm mismatch/);
  });
});
