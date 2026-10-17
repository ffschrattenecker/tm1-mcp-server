import { describe, it, expect, vi } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerSearchElements } from "../../src/tools/metadata/search-elements.js";
import { captureTool } from "../helpers/client-harness.js";

describe("tm1_search_elements", () => {
  it("leaves the Sandboxes dimension out of a cube-wide search", async () => {
    const searchElements = vi.fn(async () => ({ total: 1, elements: [] }));
    const client = {
      cubes: {
        getDimensionNames: async () => ["Sandboxes", "Region", "Product"],
      },
      elements: { searchElements },
    } as unknown as TM1Client;
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
});
