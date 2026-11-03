import { describe, it, expect } from "vitest";
import {
  ElementService,
  isAlreadyExists,
} from "../../src/tm1-client/services/element-service.js";
import { TM1Error, TM1ErrorCode, type MdxResult } from "../../src/types.js";

// Pins the cross-version "element already exists" classification (de8c806): TM1
// v11.x returns HTTP 400 with an "already exists" message where later versions
// return 409. bulkUpsert relies on this to stay idempotent — a mutation of the
// condition (e.g. dropping the 400 branch, or the substring match) would slip
// past every gate because it was only covered by the live suite, which CI never
// runs. This is that missing CI pin.
describe("isAlreadyExists", () => {
  it.each([
    ["409 Conflict", { httpStatus: 409, message: "conflict" }, true],
    [
      "400 with an 'already exists' message (v11.x)",
      {
        httpStatus: 400,
        message: "An element with name 'Region' already exists",
      },
      true,
    ],
    [
      "'already exists' only in details, not message",
      {
        httpStatus: 400,
        message: "Bad Request",
        details: "An element with that name already exists.",
      },
      true,
    ],
    [
      "'already exists' in upper case",
      { httpStatus: 400, message: "ALREADY EXISTS" },
      true,
    ],
    [
      "an unrelated 400",
      { httpStatus: 400, message: "Invalid element type ordinal" },
      false,
    ],
    [
      "a 404 that mentions 'already exists'",
      { httpStatus: 404, message: "already exists" },
      false,
    ],
  ])("%s -> %s", (_label, opts, expected) => {
    const e = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: opts.message,
      httpStatus: opts.httpStatus,
      details: "details" in opts ? opts.details : undefined,
    });
    expect(isAlreadyExists(e)).toBe(expected);
  });
});

// A 2-attribute × 3-element page, cells row-major as TM1 returns them.
function cellset(elements: string[], attrs: string[]): MdxResult {
  return {
    axes: [
      { tuples: attrs.map((a) => ({ members: [{ name: a }] })) },
      { tuples: elements.map((e) => ({ members: [{ name: e }] })) },
      // TM1 appends the slicer (Sandboxes) as a third axis.
      { tuples: [{ members: [{ name: "Base" }] }] },
    ],
    cells: elements.flatMap((e) =>
      attrs.map((a) => ({ value: `${e}.${a}`, formattedValue: "" })),
    ),
    totalCellCount: elements.length * attrs.length,
  } as unknown as MdxResult;
}

interface Calls {
  paths: string[];
  mdx: string[];
}

// ElementService over a stubbed HTTP layer (`respond` answers each request)
// and a stubbed MDX executor returning the 3 × 2 cellset. Every request path
// and MDX query is recorded in `calls`.
function makeService(respond: (path: string) => unknown = () => ({})) {
  const calls: Calls = { paths: [], mdx: [] };
  const http = {
    request: async (_m: string, path: string) => {
      calls.paths.push(path);
      return respond(path);
    },
  };
  const cells = {
    executeMdx: async (mdx: string) => {
      calls.mdx.push(mdx);
      return cellset(["A", "B", "C"], ["Caption", "Code"]);
    },
  };
  const svc = new ElementService(
    http as unknown as ConstructorParameters<typeof ElementService>[0],
    cells as unknown as ConstructorParameters<typeof ElementService>[1],
  );
  return { svc, calls };
}

// An attribute page service whose element count is `total`.
const attributeService = (total: number) =>
  makeService(() => ({ "@odata.count": total, value: [] }));

describe("ElementService.getType", () => {
  it("reads one element by key with the minimal projection", async () => {
    const { svc, calls } = makeService(() => ({
      Name: "North America",
      Type: "Consolidated",
    }));
    expect(await svc.getType("Region", "Region", "o'na")).toEqual({
      name: "North America",
      type: "Consolidated",
    });
    expect(calls.paths).toEqual([
      "/api/v1/Dimensions('Region')/Hierarchies('Region')/Elements('o''na')?$select=Name,Type",
    ]);
  });

  it("returns null when the element does not resolve", async () => {
    const { svc } = makeService(() => {
      throw new TM1Error({ code: TM1ErrorCode.NOT_FOUND, message: "404" });
    });
    expect(await svc.getType("Region", "Region", "Nope")).toBeNull();
  });

  it("rethrows anything else — a denial is not 'missing'", async () => {
    const { svc } = makeService(() => {
      throw new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message: "no",
      });
    });
    await expect(svc.getType("Region", "Region", "x")).rejects.toThrow("no");
  });
});

describe("ElementService.getAttributeValuesPage", () => {
  it("pushes the element window into the MDX row set and maps cells row-major", async () => {
    const { svc, calls } = attributeService(10);

    const out = await svc.getAttributeValuesPage("Reg]ion", {
      offset: 3,
      limit: 3,
    });

    expect(calls.paths[0]).toContain("$count=true");
    expect(calls.mdx[0]).toContain(
      "SUBSET(TM1SORT({TM1SUBSETALL([Reg]]ion].[Reg]]ion])}, ASC), 3, 3)",
    );
    expect(calls.mdx[0]).toContain(
      "{TM1SUBSETALL([}ElementAttributes_Reg]]ion]",
    );
    expect(out.total).toBe(10);
    expect(out.items).toEqual([
      { elementName: "A", values: { Caption: "A.Caption", Code: "A.Code" } },
      { elementName: "B", values: { Caption: "B.Caption", Code: "B.Code" } },
      { elementName: "C", values: { Caption: "C.Caption", Code: "C.Code" } },
    ]);
  });

  it("narrows the columns to attributeNames", async () => {
    const { svc, calls } = attributeService(3);
    await svc.getAttributeValuesPage("Region", {
      offset: 0,
      limit: 50,
      attributeNames: ["Caption", "Co]de"],
    });
    expect(calls.mdx[0]).toContain(
      "{[}ElementAttributes_Region].[}ElementAttributes_Region].[Caption], [}ElementAttributes_Region].[}ElementAttributes_Region].[Co]]de]}",
    );
  });

  it("skips the MDX past the end of the dimension", async () => {
    const { svc, calls } = attributeService(2);
    const out = await svc.getAttributeValuesPage("R", {
      offset: 5,
      limit: 50,
    });
    expect(calls.mdx).toEqual([]);
    expect(out).toEqual({ total: 2, items: [] });
  });
});
