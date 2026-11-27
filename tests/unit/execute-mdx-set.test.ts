import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import {
  captureParsedTool,
  mockResponse,
  stubbedClient,
} from "../helpers/client-harness.js";
import { registerExecuteMdxSet } from "../../src/tools/celldata/execute-mdx-set.js";
import { MdxSetResultSchema } from "../../src/tools/schemas/items.js";

describe("request shape: CellService.executeMdxSet()", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    client = stubbedClient(makeTestConfig({ requestTimeoutMs: 5000 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends POST /ExecuteMDXSetExpression with Cardinality, Tuples $top/$skip, UniqueName, Element info, and no cellset DELETE", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        Cardinality: 12,
        Tuples: [
          {
            Ordinal: 2,
            Members: [
              {
                Name: "Jan",
                UniqueName: "[Time].[Time].[Jan]",
                Element: { Type: "Numeric", Level: 0 },
              },
            ],
          },
        ],
      }),
    );

    const res = await client.cells.executeMdxSet(
      "{TM1FILTERBYLEVEL({TM1SUBSETALL([Time].[Time])}, 0)}",
      { top: 5, skip: 2 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [rawUrl, opts] = fetchSpy.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    const url = decodeURIComponent(rawUrl);
    expect(opts.method).toBe("POST");
    expect(url).toContain("/api/v1/ExecuteMDXSetExpression?");
    expect(url).toContain("$select=Cardinality");
    expect(url).toContain("$top=5");
    expect(url).toContain("$skip=2");
    expect(url).toContain(
      "Members($select=Name,UniqueName;$expand=Element($select=Type,Level))",
    );
    expect(JSON.parse(opts.body)).toEqual({
      MDX: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Time].[Time])}, 0)}",
    });

    expect(res).toEqual({
      cardinality: 12,
      tuples: [
        {
          ordinal: 2,
          members: [
            {
              name: "Jan",
              uniqueName: "[Time].[Time].[Jan]",
              type: "Numeric",
              level: 0,
            },
          ],
        },
      ],
    });
  });

  it("supports includeElementInfo=false and includeAttributes=true", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        Cardinality: 1,
        Tuples: [
          {
            Ordinal: 0,
            Members: [
              {
                Name: "EU",
                UniqueName: "[Region].[Region].[EU]",
                Attributes: { Caption: "Europe" },
              },
            ],
          },
        ],
      }),
    );

    const res = await client.cells.executeMdxSet("{[Region].[EU]}", {
      includeElementInfo: false,
      includeAttributes: true,
    });

    const url = decodeURIComponent(String(fetchSpy.mock.calls[0][0]));
    expect(url).toContain("Members($select=Name,UniqueName,Attributes)");
    expect(url).not.toContain("$expand=Element");
    expect(res.tuples[0]?.members[0]).toEqual({
      name: "EU",
      uniqueName: "[Region].[Region].[EU]",
      attributes: { Caption: "Europe" },
    });
  });
});

describe("tm1_execute_mdx_set tool", () => {
  it("paginates multi-member crossjoin tuples and passes outputSchema", async () => {
    const client = {
      cells: {
        executeMdxSet: vi.fn().mockResolvedValue({
          cardinality: 4,
          tuples: [
            {
              ordinal: 0,
              members: [
                { name: "Jan", type: "Numeric", level: 0 },
                { name: "Actual", type: "Numeric", level: 0 },
              ],
            },
            {
              ordinal: 1,
              members: [
                { name: "Feb", type: "Numeric", level: 0 },
                { name: "Actual", type: "Numeric", level: 0 },
              ],
            },
          ],
        }),
      },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerExecuteMdxSet, client);
    const res = (await call({
      mdx: "CROSSJOIN({[Time].[Jan],[Time].[Feb]}, {[Version].[Actual]})",
      limit: 2,
      offset: 0,
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(res.content[0].text);
    expect(() => MdxSetResultSchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      total: 4,
      count: 2,
      offset: 0,
      has_more: true,
      next_offset: 2,
    });
  });

  it("renders markdown table when format='markdown'", async () => {
    const client = {
      cells: {
        executeMdxSet: vi.fn().mockResolvedValue({
          cardinality: 1,
          tuples: [
            {
              ordinal: 0,
              members: [
                {
                  name: "Jan",
                  uniqueName: "[Time].[Time].[Jan]",
                  type: "Numeric",
                  level: 0,
                },
              ],
            },
          ],
        }),
      },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerExecuteMdxSet, client);
    const res = (await call({
      mdx: "{[Time].[Jan]}",
      format: "markdown",
    })) as { content: Array<{ text: string }> };

    expect(res.content[0].text).toContain("## MDX set expression");
    expect(res.content[0].text).toContain(
      "| 0 | Jan | [Time].[Time].[Jan] | Numeric | 0 |",
    );
  });
});
