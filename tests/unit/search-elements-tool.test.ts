import { describe, it, expect, vi } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerSearchElements } from "../../src/tools/metadata/search-elements.js";
import { captureParsedTool, captureTool } from "../helpers/client-harness.js";

function clientWith(dimensions: string[]) {
  const getDimensionNames = vi.fn(async () => dimensions);
  const searchElements = vi.fn(async () => ({ total: 1, elements: [] }));
  const client = {
    cubes: { getDimensionNames },
    elements: { searchElements },
  } as unknown as TM1Client;
  return { client, getDimensionNames, searchElements };
}

describe("tm1_search_elements", () => {
  it("leaves the Sandboxes dimension out of a cube-wide search", async () => {
    const { client, searchElements } = clientWith([
      "Sandboxes",
      "Region",
      "Product",
    ]);
    const { cb } = captureTool(registerSearchElements, client);

    const res = await cb(
      { searchTerm: "north", cubeName: "Sales", topN: 10 },
      {},
    );

    const searched = (searchElements.mock.calls as unknown as string[][]).map(
      (c) => c[0],
    );
    expect(searched).toEqual(["Region", "Product"]);
    expect(JSON.parse(res.content[0].text).dimensions).toHaveLength(2);
  });

  it("searches one dimension when only dimensionName is given", async () => {
    const { client, getDimensionNames, searchElements } = clientWith([]);
    const { cb } = captureTool(registerSearchElements, client);

    await cb({ searchTerm: "north", dimensionName: "Region", topN: 10 }, {});

    expect(getDimensionNames).not.toHaveBeenCalled();
    expect(searchElements.mock.calls[0]?.slice(0, 2)).toEqual([
      "Region",
      "Region",
    ]);
  });

  it("refuses both cubeName and dimensionName, and neither", async () => {
    const { client, searchElements } = clientWith(["Region"]);
    const { cb } = captureTool(registerSearchElements, client);

    await expect(
      cb(
        {
          searchTerm: "north",
          cubeName: "Sales",
          dimensionName: "Region",
          topN: 10,
        },
        {},
      ),
    ).rejects.toThrow(/exactly one of cubeName or dimensionName/);
    await expect(cb({ searchTerm: "north", topN: 10 }, {})).rejects.toThrow(
      /exactly one of cubeName or dimensionName/,
    );
    expect(searchElements).not.toHaveBeenCalled();
  });

  it("rejects an empty cubeName before any TM1 call", async () => {
    const { client, getDimensionNames, searchElements } = clientWith([
      "undefined",
    ]);
    const h = captureParsedTool(registerSearchElements, client);

    await expect(async () =>
      h({ searchTerm: "north", cubeName: "", topN: 10 }),
    ).rejects.toThrow(/too_small/);
    expect(getDimensionNames).not.toHaveBeenCalled();
    expect(searchElements).not.toHaveBeenCalled();
  });

  it("rejects an empty dimensionName before any TM1 call", async () => {
    const { client, searchElements } = clientWith([]);
    const h = captureParsedTool(registerSearchElements, client);

    await expect(async () =>
      h({ searchTerm: "north", dimensionName: "", topN: 10 }),
    ).rejects.toThrow(/too_small/);
    expect(searchElements).not.toHaveBeenCalled();
  });
});
