// tm1_write_cells refuses a consolidated coordinate before it sends anything.
//
// The reason it pre-checks rather than letting TM1 answer: a chunk holding one
// non-writable cell is refused WHOLE (see cell-service.ts), so a single
// consolidated coordinate silently costs every writable cell that travelled
// with it. The guard turns that into one validation error naming the offender.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerWriteCells } from "../../src/tools/celldata/write-cells.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeFakeServer() {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      _name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      parser = z.object(schema);
      captured = handler;
    },
  };
  return {
    server: server as unknown as Parameters<typeof registerWriteCells>[0],
    getHandler: (): ToolHandler => {
      if (!captured || !parser) throw new Error("handler not registered");
      const p = parser;
      const h = captured;
      // Parse through the registered schema rather than passing the object
      // straight in, so the handler sees exactly what the SDK would hand it.
      return (args) => h(p.parse(args));
    },
  };
}

const ELEMENTS_RE =
  /\/api\/v1\/Dimensions\('([^']+)'\)\/Hierarchies\('([^']+)'\)\/Elements\?(.*)$/;

/**
 * @param consolidated element names that answer `Type eq 3`, per "Dim/Hier".
 */
function makeClient(consolidated: Record<string, string[]>) {
  const probed: string[] = [];
  const request = async (_method: string, path: string) => {
    const m = ELEMENTS_RE.exec(path);
    if (!m) throw new Error(`unexpected path ${path}`);
    const [, dim, hier, query] = m;
    probed.push(`${dim}/${hier}`);
    const filter = decodeURIComponent(
      /\$filter=([^&]*)/.exec(query)?.[1] ?? "",
    );
    expect(filter.startsWith("Type eq 3 and (")).toBe(true);
    const asked = [...filter.matchAll(/Name eq '((?:[^']|'')*)'/g)].map((x) =>
      x[1].replace(/''/g, "'"),
    );
    const known = consolidated[`${dim}/${hier}`] ?? [];
    return {
      value: asked.filter((n) => known.includes(n)).map((n) => ({ Name: n })),
    };
  };
  type Ctor = ConstructorParameters<typeof ElementService>;
  const elements = new ElementService(
    { request } as unknown as Ctor[0],
    undefined as unknown as Ctor[1],
  );
  const writeCells = vi.fn(async () => undefined);
  return {
    probed,
    writeCells,
    client: { elements, cells: { writeCells } } as unknown as TM1Client,
  };
}

function handlerFor(client: TM1Client): ToolHandler {
  const fake = makeFakeServer();
  registerWriteCells(fake.server, client);
  return fake.getHandler();
}

const CELL = (elements: string[]) => ({ elements, value: 42 });

describe("tm1_write_cells consolidated guard", () => {
  it("refuses the call and sends nothing when a coordinate is consolidated", async () => {
    const { client, writeCells } = makeClient({ "Region/Region": ["Europe"] });
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        dimensions: ["Region", "Month"],
        cells: [CELL(["Europe", "Jan"]), CELL(["Berlin", "Jan"])],
        confirm: "Sales",
      }),
    ).rejects.toThrow(/Region:Europe/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("writes when every coordinate is a leaf", async () => {
    const { client, writeCells } = makeClient({});
    await handlerFor(client)({
      cubeName: "Sales",
      dimensions: ["Region", "Month"],
      cells: [CELL(["Berlin", "Jan"])],
      confirm: "Sales",
    });
    expect(writeCells).toHaveBeenCalledTimes(1);
  });

  it("probes the named hierarchy for a qualified [Dim].[Hier].[Elem] member", async () => {
    const { client, probed } = makeClient({});
    await handlerFor(client)({
      cubeName: "Sales",
      dimensions: ["Region", "Month"],
      cells: [CELL(["[Region].[Alt].[Europe]", "Jan"])],
      confirm: "Sales",
    });
    expect(probed).toContain("Region/Alt");
    expect(probed).not.toContain("Region/Region");
  });
});
