import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockResponse, stubbedClient } from "../helpers/client-harness.js";

/** The JSON body of the MDX request (the second call: the first reads attributes). */
const mdxOf = (fetchSpy: FnSpy): string =>
  (
    JSON.parse(
      String((fetchSpy.mock.calls[1][1] as { body: string }).body),
    ) as { MDX: string }
  ).MDX;

const twoMatches = (cardinality: number) =>
  mockResponse({
    Cardinality: cardinality,
    Tuples: [
      {
        Members: [
          {
            Name: "North_Ab",
            Attributes: {},
            Element: { Type: "Numeric", Level: 0 },
          },
        ],
      },
      {
        Members: [
          {
            Name: "K17",
            Attributes: { Site: "Ab Ville" },
            Element: { Type: "Consolidated", Level: 1 },
          },
        ],
      },
    ],
  });

// OData cannot filter on attribute values (v11 error 278), so the search is
// an MDX FILTER over the name and every String/Alias attribute.
describe("ElementService.searchElements", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    client = stubbedClient(makeTestConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters on name and text attributes, escapes, and reports the matching attribute", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          { Name: "Site", Type: "String" },
          { Name: "Weight", Type: "Numeric" },
          { Name: "Short", Type: "Alias" },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(twoMatches(7));

    const r = await client.elements.searchElements(
      "Reg]ion",
      "Reg]ion",
      'A"b',
      2,
      ["Site", "Weight", "Missing"],
    );

    const mdx = mdxOf(fetchSpy);
    expect(mdx).toContain("TM1SUBSETALL([Reg]]ion].[Reg]]ion])");
    expect(mdx).toContain('Properties("Site")');
    expect(mdx).toContain('Properties("Short")');
    expect(mdx).not.toContain("Weight");
    expect(mdx).toContain('"a""b"');
    expect(String(fetchSpy.mock.calls[1][0])).toContain("Tuples($top=2;");

    expect(r.total).toBe(7);
    expect(r.elements.map((m) => m.name)).toEqual(["North_Ab", "K17"]);
  });

  it("searches Alias attributes only unless String attributes are named", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          { Name: "Site", Type: "String" },
          { Name: "Short", Type: "Alias" },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ Cardinality: 0, Tuples: [] }),
    );
    await client.elements.searchElements("Region", "Region", "x", 10);

    const mdx = mdxOf(fetchSpy);
    expect(mdx).toContain('Properties("Short")');
    expect(mdx).not.toContain("Site");
  });

  it("names the attribute that matched", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ value: [{ Name: "Site", Type: "String" }] }),
    );
    fetchSpy.mockResolvedValueOnce(twoMatches(2));
    const r = await client.elements.searchElements(
      "Region",
      "Region",
      "AB",
      10,
      ["Site"],
    );
    expect(r.elements).toEqual([
      {
        name: "North_Ab",
        type: "Numeric",
        level: 0,
        matchedOn: "Name",
        matchedValue: "North_Ab",
      },
      {
        name: "K17",
        type: "Consolidated",
        level: 1,
        matchedOn: "Site",
        matchedValue: "Ab Ville",
      },
    ]);
  });
});
