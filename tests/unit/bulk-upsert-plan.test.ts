import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import { registerBulkUpsertElements } from "../../src/tools/dimension-management/bulk-upsert-elements.js";
import type { TM1Client } from "../../src/tm1-client.js";

type Ctor = ConstructorParameters<typeof ElementService>;

// Installed: Total = {A, B}, leaves A, B, C.
const INSTALLED = [
  {
    Name: "Total",
    Type: "Consolidated",
    Edges: [{ ComponentName: "A" }, { ComponentName: "B" }],
  },
  { Name: "A", Type: "Numeric", Edges: [] },
  { Name: "B", Type: "Numeric", Edges: [] },
  { Name: "C", Type: "Numeric", Edges: [] },
];

function service(paths: string[]) {
  const http = {
    request: async (_m: string, path: string) => {
      paths.push(path);
      const filter = decodeURIComponent(path.split("$filter=")[1] ?? "");
      const wanted = [...filter.matchAll(/Name eq '((?:[^']|'')*)'/g)].map(
        (m) => m[1].replace(/''/g, "'"),
      );
      return { value: INSTALLED.filter((e) => wanted.includes(e.Name)) };
    },
  };
  return new ElementService(http as unknown as Ctor[0], {} as Ctor[1]);
}

describe("ElementService.planBulkUpsert", () => {
  it("sorts the request into creates, updates, type changes and dropped children", async () => {
    const paths: string[] = [];
    const plan = await service(paths).planBulkUpsert("Region", "Region", [
      { name: "D", type: "Numeric" },
      { name: "C", type: "String" },
      {
        name: "Total",
        type: "Consolidated",
        components: [
          { name: "A", weight: 1 },
          { name: "D", weight: 1 },
        ],
      },
    ]);
    expect(plan).toEqual({
      creates: ["D"],
      updates: ["C", "Total"],
      typeChanges: [{ name: "C", from: "Numeric", to: "String" }],
      removals: [{ parent: "Total", children: ["B"] }],
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("$expand=Edges($select=ComponentName)");
  });

  it("reads in chunks of 40 names", async () => {
    const paths: string[] = [];
    await service(paths).planBulkUpsert(
      "Region",
      "Region",
      Array.from({ length: 85 }, (_, i) => ({
        name: `E${i}`,
        type: "Numeric" as const,
      })),
    );
    expect(paths).toHaveLength(3);
  });
});

describe("tm1_bulk_upsert_elements removal guard", () => {
  function call(args: Record<string, unknown>, upserts: unknown[][]) {
    let h: ((a: unknown) => Promise<unknown>) | null = null;
    let parser: z.ZodObject<ZodRawShape> | null = null;
    const svc = service([]);
    registerBulkUpsertElements(
      {
        tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
          parser = z.object(s);
          h = cb;
        },
      } as never,
      {
        elements: {
          planBulkUpsert: svc.planBulkUpsert.bind(svc),
          bulkUpsert: async (...a: unknown[]) => {
            upserts.push(a);
            return { typeChanges: [] };
          },
        },
      } as unknown as TM1Client,
    );
    return h!(parser!.parse(args)) as Promise<{
      structuredContent: Record<string, unknown>;
    }>;
  }

  const dropB = {
    dimensionName: "Region",
    elements: [
      {
        name: "Total",
        type: "Consolidated",
        components: [{ name: "A" }],
      },
    ],
  };

  it("refuses to drop children without confirm, before anything is written", async () => {
    const upserts: unknown[][] = [];
    const err = await call(dropB, upserts).catch((e: unknown) => e);
    expect((err as Error).message).toContain(
      "would remove 1 existing child link(s) under Total",
    );
    expect(JSON.parse((err as { details: string }).details)).toEqual({
      removals: [{ parent: "Total", children: ["B"] }],
    });
    expect(upserts).toEqual([]);
  });

  it("proceeds with confirm=<dimension name>", async () => {
    const upserts: unknown[][] = [];
    await call({ ...dropB, confirm: "Region" }, upserts);
    expect(upserts).toHaveLength(1);
  });

  it("dryRun returns the plan and writes nothing", async () => {
    const upserts: unknown[][] = [];
    const res = await call({ ...dropB, dryRun: true }, upserts);
    expect(res.structuredContent).toMatchObject({
      dryRun: true,
      removals: [{ parent: "Total", children: ["B"] }],
    });
    expect(upserts).toEqual([]);
  });

  it("needs no confirm when the components keep every child", async () => {
    const upserts: unknown[][] = [];
    await call(
      {
        dimensionName: "Region",
        elements: [
          {
            name: "Total",
            type: "Consolidated",
            components: [{ name: "A" }, { name: "B" }, { name: "C" }],
          },
        ],
      },
      upserts,
    );
    expect(upserts).toHaveLength(1);
  });
});
