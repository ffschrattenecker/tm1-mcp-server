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
import {
  CELL_NOT_UPDATEABLE_BIT,
  buildCellsExpand,
  decodeUpdateable,
} from "../../src/tm1-client/services/cellset-transform.js";
import {
  registerExecuteMdx,
  renderMdxMarkdown,
} from "../../src/tools/celldata/execute-mdx.js";
import { registerGetView } from "../../src/tools/celldata/get-view.js";
import {
  MdxResultSchema,
  ViewResultSchema,
} from "../../src/tools/schemas/items.js";

describe("decodeUpdateable bitmask", () => {
  it.each([
    ["0 (no restrictions)", 0, true],
    ["16 (sandbox diff bit without bit 29)", 16, true],
    [
      "268435456 (0x10000000, bit 29 = NOT updateable)",
      CELL_NOT_UPDATEABLE_BIT,
      false,
    ],
    ["268435460 (bit 29 + rule bit)", CELL_NOT_UPDATEABLE_BIT | 4, false],
    ["boolean true", true, true],
    ["boolean false", false, false],
  ])("%s -> %s", (_label, raw, expected) => {
    expect(decodeUpdateable(raw)).toBe(expected);
  });

  it("buildCellsExpand deduplicates cellProperties and preserves default when absent", () => {
    expect(buildCellsExpand(10, 0)).toBe(
      "Cells($select=Value,FormattedValue;$top=10;$skip=0)",
    );
    expect(
      buildCellsExpand(undefined, undefined, [
        "RuleDerived",
        "Updateable",
        "RuleDerived",
        "HasPicklist",
      ]),
    ).toBe(
      "Cells($select=Value,FormattedValue,RuleDerived,Updateable,HasPicklist)",
    );
  });
});

describe("request shape: cellProperties on executeMdx and private/sandbox on getView", () => {
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

  it("executeMdx requests cellProperties and decodes Updateable bitmask", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({
          ID: "cs-meta",
          Cells: [
            {
              Value: 100,
              FormattedValue: "100",
              RuleDerived: true,
              Updateable: CELL_NOT_UPDATEABLE_BIT | 4,
              HasPicklist: false,
            },
            {
              Value: 50,
              FormattedValue: "50",
              RuleDerived: false,
              Updateable: 0,
              HasPicklist: true,
            },
          ],
          Axes: [
            {
              Tuples: [
                { Members: [{ Name: "Jan", Hierarchy: { Name: "Time" } }] },
              ],
            },
            {
              Tuples: [
                { Members: [{ Name: "Rev", Hierarchy: { Name: "Acct" } }] },
                { Members: [{ Name: "Units", Hierarchy: { Name: "Acct" } }] },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(mockResponse({}));

    const res = await client.cells.executeMdx(
      "SELECT ...",
      undefined,
      undefined,
      undefined,
      undefined,
      ["RuleDerived", "Updateable", "HasPicklist"],
    );

    const url = decodeURIComponent(String(fetchSpy.mock.calls[0][0]));
    expect(url).toContain(
      "Cells($select=Value,FormattedValue,RuleDerived,Updateable,HasPicklist)",
    );
    expect(res.cells[0]).toEqual({
      value: 100,
      formattedValue: "100",
      ruleDerived: true,
      updateable: false,
      updateableBitmask: CELL_NOT_UPDATEABLE_BIT | 4,
      hasPicklist: false,
    });
    expect(res.cells[1]).toEqual({
      value: 50,
      formattedValue: "50",
      ruleDerived: false,
      updateable: true,
      updateableBitmask: 0,
      hasPicklist: true,
    });
  });

  it("views.getView supports PrivateViews, !sandbox on both Execute and DELETE Cellsets, and cellProperties", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({
          ID: "cs-view",
          Cells: [{ Value: 7, FormattedValue: "7", RuleDerived: false }],
          Axes: [
            {
              Tuples: [
                { Members: [{ Name: "Q1", Hierarchy: { Name: "Time" } }] },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(mockResponse({}));

    const res = await client.views.getView(
      "Sales",
      "MyPrivView",
      50,
      0,
      undefined,
      {
        isPrivate: true,
        sandbox: "mcp-whatif",
        cellProperties: ["RuleDerived"],
      },
    );

    const execUrl = decodeURIComponent(String(fetchSpy.mock.calls[0][0]));
    expect(execUrl).toContain(
      "/api/v1/Cubes('Sales')/PrivateViews('MyPrivView')/tm1.Execute?",
    );
    expect(execUrl).toContain(
      "Cells($select=Value,FormattedValue,RuleDerived;$top=50;$skip=0)",
    );
    expect(execUrl).toContain("!sandbox=mcp-whatif");

    const delUrl = decodeURIComponent(String(fetchSpy.mock.calls[1][0]));
    expect(delUrl).toContain("/api/v1/Cellsets('cs-view')");
    expect(delUrl).toContain("!sandbox=mcp-whatif");

    expect(res.private).toBe(true);
    expect(res.cells[0]).toEqual({
      value: 7,
      formattedValue: "7",
      ruleDerived: false,
    });
  });
});

describe("tm1_execute_mdx & tm1_get_view tool schemas and markdown", () => {
  it("renderMdxMarkdown appends metadata columns when cell metadata is present", () => {
    const md = renderMdxMarkdown({
      axes: [
        { tuples: [{ members: [{ name: "Jan", hierarchyName: "Time" }] }] },
        { tuples: [{ members: [{ name: "Rev", hierarchyName: "Acct" }] }] },
      ],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        {
          value: 10,
          formattedValue: "10",
          ruleDerived: true,
          updateable: false,
        },
      ],
    });
    expect(md).toContain("| Time | Acct | Value | RuleDerived | Updateable |");
    expect(md).toContain("| Jan | Rev | 10 | true | false |");
  });

  it("tm1_execute_mdx and tm1_get_view pass outputSchema validation with metadata flags", async () => {
    const client = {
      cells: {
        executeMdx: vi.fn().mockResolvedValue({
          axes: [],
          cells: [
            {
              value: 1,
              formattedValue: "1",
              ruleDerived: false,
              updateable: true,
              updateableBitmask: 0,
            },
          ],
          totalCellCount: 1,
        }),
      },
      views: {
        getView: vi.fn().mockResolvedValue({
          cubeName: "Sales",
          viewName: "Priv",
          private: true,
          axes: [],
          cells: [{ value: 2, formattedValue: "2", hasPicklist: true }],
          totalCellCount: 1,
        }),
      },
    } as unknown as TM1Client;

    const callMdx = captureParsedTool(registerExecuteMdx, client);
    const mdxRes = (await callMdx({
      mdx: "SELECT ...",
      cellProperties: ["RuleDerived", "Updateable"],
    })) as { content: Array<{ text: string }> };
    expect(() =>
      MdxResultSchema.parse(JSON.parse(mdxRes.content[0].text)),
    ).not.toThrow();

    const callView = captureParsedTool(registerGetView, client);
    const viewRes = (await callView({
      cubeName: "Sales",
      viewName: "Priv",
      private: true,
      sandbox: "mcp-sb",
      cellProperties: ["HasPicklist"],
    })) as { content: Array<{ text: string }> };
    const viewPayload = JSON.parse(viewRes.content[0].text);
    expect(() => ViewResultSchema.parse(viewPayload)).not.toThrow();
    expect(viewPayload.private).toBe(true);
  });
});
