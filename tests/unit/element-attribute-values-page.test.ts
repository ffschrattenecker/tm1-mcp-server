import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import { registerGetElementAttributeValues } from "../../src/tools/dimension-management/get-element-attribute-values.js";
import type { TM1Client } from "../../src/tm1-client.js";
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

describe("tm1_get_element_attribute_values without elementName", () => {
  function handlerFor(client: unknown) {
    let h: ((a: unknown) => Promise<{ content: { text: string }[] }>) | null =
      null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    registerGetElementAttributeValues(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      client as TM1Client,
    );
    return (args: Record<string, unknown>) => h!(parser!.parse(args));
  }

  it("returns a page envelope with has_more/next_offset", async () => {
    const svc = makeService(10, [], []);
    const call = handlerFor({ elements: svc });
    const out = JSON.parse(
      (await call({ dimensionName: "Region", limit: 3 })).content[0].text,
    );
    expect(out.dimensionName).toBe("Region");
    expect(out.total).toBe(10);
    expect(out.count).toBe(3);
    expect(out.has_more).toBe(true);
    expect(out.next_offset).toBe(3);
    expect(out.items[0].values.Code).toBe("A.Code");
  });

  it("keeps the single-element shape when elementName is given", async () => {
    const call = handlerFor({
      elements: {
        getAttributeValues: async () => [
          { elementName: "A", attributeName: "Code", value: "x" },
        ],
      },
    });
    const out = JSON.parse(
      (await call({ dimensionName: "Region", elementName: "A" })).content[0]
        .text,
    );
    expect(out).toEqual({
      dimensionName: "Region",
      elementName: "A",
      attributes: [{ elementName: "A", attributeName: "Code", value: "x" }],
    });
  });
});
