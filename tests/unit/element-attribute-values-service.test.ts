import { describe, it, expect } from "vitest";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import type { MdxResult } from "../../src/types.js";

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

function makeService(total: number, mdxSeen: string[], paths: string[]) {
  const http = {
    request: async (_m: string, path: string) => {
      paths.push(path);
      return { "@odata.count": total, value: [] };
    },
  };
  const cells = {
    executeMdx: async (mdx: string) => {
      mdxSeen.push(mdx);
      return cellset(["A", "B", "C"], ["Caption", "Code"]);
    },
  };
  return new ElementService(
    http as unknown as ConstructorParameters<typeof ElementService>[0],
    cells as unknown as ConstructorParameters<typeof ElementService>[1],
  );
}

describe("ElementService.getAttributeValuesPage", () => {
  it("pushes the element window into the MDX row set and maps cells row-major", async () => {
    const mdx: string[] = [];
    const paths: string[] = [];
    const svc = makeService(10, mdx, paths);

    const out = await svc.getAttributeValuesPage("Reg]ion", {
      offset: 3,
      limit: 3,
    });

    expect(paths[0]).toContain("$count=true");
    expect(mdx[0]).toContain(
      "SUBSET(TM1SORT({TM1SUBSETALL([Reg]]ion].[Reg]]ion])}, ASC), 3, 3)",
    );
    expect(mdx[0]).toContain("{TM1SUBSETALL([}ElementAttributes_Reg]]ion]");
    expect(out.total).toBe(10);
    expect(out.items).toEqual([
      { elementName: "A", values: { Caption: "A.Caption", Code: "A.Code" } },
      { elementName: "B", values: { Caption: "B.Caption", Code: "B.Code" } },
      { elementName: "C", values: { Caption: "C.Caption", Code: "C.Code" } },
    ]);
  });

  it("narrows the columns to attributeNames", async () => {
    const mdx: string[] = [];
    const svc = makeService(3, mdx, []);
    await svc.getAttributeValuesPage("Region", {
      offset: 0,
      limit: 50,
      attributeNames: ["Caption", "Co]de"],
    });
    expect(mdx[0]).toContain(
      "{[}ElementAttributes_Region].[}ElementAttributes_Region].[Caption], [}ElementAttributes_Region].[}ElementAttributes_Region].[Co]]de]}",
    );
  });

  it("skips the MDX past the end of the dimension", async () => {
    const mdx: string[] = [];
    const out = await makeService(2, mdx, []).getAttributeValuesPage("R", {
      offset: 5,
      limit: 50,
    });
    expect(mdx).toEqual([]);
    expect(out).toEqual({ total: 2, items: [] });
  });
});
