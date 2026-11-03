import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1ErrorCode } from "../../src/types.js";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { type TM1Client } from "../../src/tm1-client.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockResponse, stubbedClient } from "../helpers/client-harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeConfig = () => makeTestConfig({ requestTimeoutMs: 5000 });

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – Cell Data Methods", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);

    const config = makeConfig();
    client = stubbedClient(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── getCellValue() ─────────────────────────────────────────────────────────

  describe("cells.getValue()", () => {
    const salesCubeMeta = {
      Name: "SalesCube",
      Dimensions: [{ Name: "Time" }, { Name: "Region" }, { Name: "Scenario" }],
    };
    const statusCubeMeta = {
      Name: "StatusCube",
      Dimensions: [{ Name: "Time" }, { Name: "Status" }],
    };
    it("should return a numeric cell value with hierarchically qualified MDX", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-001",
            Cells: [{ Value: 42.5, FormattedValue: "42.50" }],
          }),
        );

      const value = await client.cells.getValue("SalesCube", [
        "Jan",
        "Germany",
        "Actual",
      ]);

      expect(value).toBe(42.5);

      const [cubeUrl, cubeOpts] = fetchSpy.mock.calls[0];
      expect(cubeUrl).toContain("/api/v1/Cubes('SalesCube')");
      expect(cubeUrl).toContain("$expand=Dimensions");
      expect(cubeOpts.method).toBe("GET");

      const [mdxUrl, mdxOpts] = fetchSpy.mock.calls[1];
      expect(mdxUrl).toContain("/api/v1/ExecuteMDX");
      expect(mdxOpts.method).toBe("POST");
      const body = JSON.parse(mdxOpts.body);
      expect(body.MDX).toBe(
        "SELECT {[Time].[Jan]} ON COLUMNS FROM [SalesCube] WHERE ([Region].[Germany],[Scenario].[Actual])",
      );
    });

    // An empty cellset means a member did not resolve, not an empty cell: the
    // MDX selects exactly one member, and an empty cell comes back as a cell
    // with a null Value. v11 refuses such an MDX outright, v12 answers 200 with
    // no cells — returning null there reported "empty cell" for a coordinate
    // that does not exist.
    it.each([
      [
        "a string",
        statusCubeMeta,
        ["Q1", "Open"],
        { Cells: [{ Value: "Active", FormattedValue: "Active" }] },
        { value: "Active" },
      ],
      [
        "an empty cell",
        salesCubeMeta,
        ["Feb", "France", "Budget"],
        { Cells: [{ Value: null, FormattedValue: "" }] },
        { value: null },
      ],
      [
        "an empty Cells array",
        salesCubeMeta,
        ["Mar", "UK", "Actual"],
        { Cells: [] },
        "throws",
      ],
      [
        "a missing Cells array",
        salesCubeMeta,
        ["Apr", "US", "Actual"],
        {},
        "throws",
      ],
    ] as const)(
      "returns or throws for %s",
      async (_label, meta, coords, cellset, expected) => {
        fetchSpy
          .mockResolvedValueOnce(mockResponse(meta))
          .mockResolvedValueOnce(mockResponse({ ID: "cellset", ...cellset }));

        const call = client.cells.getValue(meta.Name, [...coords]);
        if (expected === "throws") {
          await expect(call).rejects.toMatchObject({
            code: TM1ErrorCode.NOT_FOUND,
          });
        } else {
          expect(await call).toBe(expected.value);
        }
      },
    );

    it("should pass through pre-qualified `[Dim].[Element]` element strings", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-006",
            Cells: [{ Value: 1, FormattedValue: "1" }],
          }),
        );

      await client.cells.getValue("SalesCube", [
        "[Time].[Jan]",
        "[Region].[Germany]",
        "[Scenario].[Actual]",
      ]);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.MDX).toBe(
        "SELECT {[Time].[Jan]} ON COLUMNS FROM [SalesCube] WHERE ([Region].[Germany],[Scenario].[Actual])",
      );
    });

    it("D1: doubles `]` in bracketed identifiers (MDX injection / mis-addressing)", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(salesCubeMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-d1",
            Cells: [{ Value: 1, FormattedValue: "1" }],
          }),
        );

      await client.cells.getValue("SalesCube", ["Q4]Adj", "Germany", "Actual"]);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      // `]` inside a name must be doubled so it can't terminate the identifier.
      expect(body.MDX).toContain("[Time].[Q4]]Adj]");
      expect(body.MDX).not.toContain("[Time].[Q4]Adj]");
    });

    it("should throw on dimension/element count mismatch", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(salesCubeMeta));

      await expect(
        client.cells.getValue("SalesCube", ["Jan", "Germany"]),
      ).rejects.toThrow(/3 dimensions but 2 element\(s\)/);
    });

    // EnableSandboxDimension=true puts Sandboxes in front of every cube;
    // leaving it out binds Base, as tm1_write_cells does.
    const sandboxedMeta = {
      Name: "SalesCube",
      Dimensions: [{ Name: "Sandboxes" }, { Name: "Time" }, { Name: "Region" }],
    };

    it("binds a left-out Sandboxes to Base", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(sandboxedMeta))
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-sb",
            Cells: [{ Value: 7, FormattedValue: "7" }],
          }),
        );

      expect(await client.cells.getValue("SalesCube", ["Jan", "Germany"])).toBe(
        7,
      );
      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.MDX).toBe(
        "SELECT {[Sandboxes].[Base]} ON COLUMNS FROM [SalesCube] WHERE ([Time].[Jan],[Region].[Germany])",
      );
    });

    it("refuses a sandboxed coordinate two short, naming Sandboxes as optional", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(sandboxedMeta));

      await expect(
        client.cells.getValue("SalesCube", ["Jan"]),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/3 dimensions but 1 element\(s\)/),
        hintOverride: expect.stringContaining(
          "Only Sandboxes may be left out; it is then bound to Base.",
        ),
      });
    });
  });

  // ── executeMdx() ───────────────────────────────────────────────────────────

  describe("cells.executeMdx()", () => {
    const sampleResponse = {
      ID: "cellset-100",
      Cells: [
        { Value: 100, FormattedValue: "100.00" },
        { Value: 200, FormattedValue: "200.00" },
        { Value: 150, FormattedValue: "150.00" },
        { Value: 250, FormattedValue: "250.00" },
      ],
      Axes: [
        {
          Tuples: [
            { Members: [{ Name: "Jan", Hierarchy: { Name: "Time" } }] },
            { Members: [{ Name: "Feb", Hierarchy: { Name: "Time" } }] },
          ],
        },
        {
          Tuples: [
            { Members: [{ Name: "Germany", Hierarchy: { Name: "Region" } }] },
            { Members: [{ Name: "France", Hierarchy: { Name: "Region" } }] },
          ],
        },
      ],
    };

    it("should return structured MdxResult with cells and axes", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(sampleResponse));

      const result = await client.cells.executeMdx(
        "SELECT {[Time].[Jan],[Time].[Feb]} ON COLUMNS, {[Region].[Germany],[Region].[France]} ON ROWS FROM [SalesCube]",
      );

      expect(result.cells).toEqual([
        { value: 100, formattedValue: "100.00" },
        { value: 200, formattedValue: "200.00" },
        { value: 150, formattedValue: "150.00" },
        { value: 250, formattedValue: "250.00" },
      ]);

      expect(result.axes).toHaveLength(2);
      expect(result.axes[0].tuples).toHaveLength(2);
      expect(result.axes[0].tuples[0].members[0]).toEqual({
        name: "Jan",
        hierarchyName: "Time",
      });
      expect(result.axes[1].tuples[1].members[0]).toEqual({
        name: "France",
        hierarchyName: "Region",
      });

      // totalCellCount = 2 columns * 2 rows = 4
      expect(result.totalCellCount).toBe(4);
    });

    it("maps an empty result, and every member of a multi-member tuple", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({ ID: "cellset-104", Cells: [], Axes: [] }),
        )
        .mockResolvedValueOnce(mockResponse({})) // cellset DELETE
        .mockResolvedValueOnce(
          mockResponse({
            ID: "cellset-106",
            Cells: [{ Value: 99, FormattedValue: "99" }],
            Axes: [
              {
                Tuples: [
                  {
                    Members: [
                      { Name: "Jan", Hierarchy: { Name: "Time" } },
                      { Name: "Actual", Hierarchy: { Name: "Version" } },
                    ],
                  },
                ],
              },
            ],
          }),
        );

      const empty = await client.cells.executeMdx(
        "SELECT {} ON COLUMNS FROM [EmptyCube]",
      );
      expect(empty.cells).toEqual([]);
      expect(empty.axes).toEqual([]);
      expect(empty.totalCellCount).toBe(0);

      const multi = await client.cells.executeMdx("SELECT ...");
      expect(multi.axes[0].tuples[0].members).toEqual([
        { name: "Jan", hierarchyName: "Time" },
        { name: "Actual", hierarchyName: "Version" },
      ]);
    });

    it("frees the server-side cellset with a DELETE after reading (H2)", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(sampleResponse))
        .mockResolvedValueOnce(mockResponse({}));

      await client.cells.executeMdx("SELECT {} ON COLUMNS FROM [SalesCube]");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [delUrl, delOpts] = fetchSpy.mock.calls[1];
      expect(delOpts.method).toBe("DELETE");
      expect(delUrl).toContain("/api/v1/Cellsets('cellset-100')");
    });

    it("still returns the read result when cellset cleanup fails", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(sampleResponse))
        .mockRejectedValueOnce(new Error("network blip on DELETE"));

      const result = await client.cells.executeMdx(
        "SELECT {} ON COLUMNS FROM [SalesCube]",
      );
      expect(result.totalCellCount).toBe(4);
    });

    it.each([
      ["$top", 10, undefined, ["$top=10"], ["$skip="]],
      ["$skip", undefined, 5, ["$skip=5"], ["$top="]],
      ["$top and $skip", 20, 10, ["$top=20", "$skip=10"], []],
    ])(
      "sends %s in the request when provided",
      async (_label, top, skip, present, absent) => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse({ ID: "cellset-p", Cells: [], Axes: [] }),
        );

        await client.cells.executeMdx(
          "SELECT {} ON COLUMNS FROM [Cube]",
          top,
          skip,
        );

        const [url] = fetchSpy.mock.calls[0];
        for (const s of present) expect(url).toContain(s);
        for (const s of absent) expect(url).not.toContain(s);
      },
    );

    it("should compute totalCellCount from axes cardinality", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-105",
          Cells: [
            { Value: 1, FormattedValue: "1" },
            { Value: 2, FormattedValue: "2" },
          ],
          Axes: [
            {
              Tuples: [
                { Members: [{ Name: "A", Hierarchy: { Name: "D1" } }] },
                { Members: [{ Name: "B", Hierarchy: { Name: "D1" } }] },
                { Members: [{ Name: "C", Hierarchy: { Name: "D1" } }] },
              ],
            },
            {
              Tuples: [
                { Members: [{ Name: "X", Hierarchy: { Name: "D2" } }] },
                { Members: [{ Name: "Y", Hierarchy: { Name: "D2" } }] },
              ],
            },
          ],
        }),
      );

      const result = await client.cells.executeMdx("SELECT ...", 2);

      // totalCellCount = 3 * 2 = 6, even though only 2 cells returned (paginated)
      expect(result.totalCellCount).toBe(6);
      expect(result.cells).toHaveLength(2);
    });
  });

  // ── writeCells() coordinate MDX (D1 escaping / D2 alt-hierarchy) ────────────

  describe("cells.writeCells() coordinate MDX", () => {
    // Accept every write cell; capture the ExecuteMDX slice bodies.
    function routeOk(): void {
      fetchSpy.mockImplementation((url: unknown) => {
        if (String(url).includes("/ExecuteMDX")) {
          return Promise.resolve(mockResponse({ ID: "cs" }));
        }
        return Promise.resolve(mockResponse({}));
      });
    }

    function firstMdx(): string {
      const call = fetchSpy.mock.calls.find(([u]) =>
        String(u).includes("/ExecuteMDX"),
      );
      return JSON.parse((call![1] as { body: string }).body).MDX as string;
    }

    it("D1: doubles `]` in write-coordinate identifiers", async () => {
      routeOk();
      await client.cells.writeCells(
        "Sales",
        ["Time", "Region"],
        [{ elements: ["Q4]Adj", "EU"], value: 5 }],
      );
      const mdx = firstMdx();
      expect(mdx).toContain("[Time].[Time].[Q4]]Adj]");
      expect(mdx).not.toContain("[Time].[Time].[Q4]Adj]");
    });

    it("D2: honors an explicit alternate hierarchy in a pre-qualified ref", async () => {
      routeOk();
      await client.cells.writeCells(
        "Sales",
        ["Time", "Region"],
        [{ elements: ["[Time].[FiscalCal].[Q4]", "EU"], value: 5 }],
      );
      const mdx = firstMdx();
      // Every coordinate is one tuple in a single set now, but qualification is
      // unchanged: an alternate hierarchy survives verbatim…
      expect(mdx).toContain("[Time].[FiscalCal].[Q4]");
      expect(mdx).not.toContain("[Time].[Time].[Time]");
      // …and a bare element still defaults its hierarchy to the dimension name.
      expect(mdx).toContain("[Region].[Region].[EU]");
    });

    it("defaults hierarchy to the dimension name for bare elements (unchanged behavior)", async () => {
      routeOk();
      await client.cells.writeCells(
        "Sales",
        ["Time", "Region"],
        [{ elements: ["Jan", "EU"], value: 5 }],
      );
      const mdx = firstMdx();
      expect(mdx).toContain("([Time].[Time].[Jan],[Region].[Region].[EU])");
    });
  });

  // ── getView() ──────────────────────────────────────────────────────────────

  describe("views.getView()", () => {
    it("should return ViewResult with cubeName, viewName, cells and axes", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ID: "cellset-200",
          Cells: [
            { Value: 500, FormattedValue: "500.00" },
            { Value: 600, FormattedValue: "600.00" },
          ],
          Axes: [
            {
              Tuples: [
                { Members: [{ Name: "Q1", Hierarchy: { Name: "Time" } }] },
                { Members: [{ Name: "Q2", Hierarchy: { Name: "Time" } }] },
              ],
            },
          ],
        }),
      );

      const result = await client.views.getView("SalesCube", "DefaultView");

      expect(result.cubeName).toBe("SalesCube");
      expect(result.viewName).toBe("DefaultView");
      expect(result.cells).toEqual([
        { value: 500, formattedValue: "500.00" },
        { value: 600, formattedValue: "600.00" },
      ]);
      expect(result.axes).toHaveLength(1);
      expect(result.axes[0].tuples).toHaveLength(2);
    });
  });

  // ── clearCube() ────────────────────────────────────────────────────────────

  describe("cubes.clear()", () => {
    function newClient(version: string): TM1Client {
      // Service version-gating branches on the NUMERIC config.version (source of
      // truth); tm1Version is display-only. Derive the numeric from the string.
      const numericVersion: 11 | 12 = version.startsWith("11") ? 11 : 12;
      const cfg = {
        ...makeConfig(),
        version: numericVersion,
        tm1Version: version,
      };
      return stubbedClient(cfg, "s");
    }

    function mock204(): Response {
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockRejectedValue(new Error("No content")),
      } as unknown as Response;
    }

    // Measured on 12.5: POST Cubes('x')/tm1.Clear answers "'tm1.Clear'
    // resource can not be resolved on type 'Cube'", and $metadata declares no
    // clear action at all. The clear therefore takes the same TI route on every
    // version rather than an endpoint this build does not have.
    it.each([
      ["12.x", "12.0"],
      ["11.x", "11.8"],
    ])(
      "%s clear: deploys ephemeral TI, executes, deletes",
      async (_l, version) => {
        const c = newClient(version);
        fetchSpy
          .mockResolvedValueOnce(mock204()) // create process
          // T-4: the execute must actually report CompletedSuccessfully. A body
          // without ProcessExecuteStatusCode no longer counts as a confirmed
          // clear — see the "unconfirmed clear" case below.
          .mockResolvedValueOnce(
            mockResponse({ ProcessExecuteStatusCode: "CompletedSuccessfully" }),
          ) // execute
          .mockResolvedValueOnce(mock204()); // delete

        await c.cubes.clear("Sales");

        const [createUrl, createOpts] = fetchSpy.mock.calls[0];
        expect(createUrl).toContain("/Processes");
        expect(createOpts.method).toBe("POST");
        const createBody = JSON.parse(createOpts.body);
        expect(createBody.Name).toMatch(/^}TempClear_Sales_\d+$/);
        expect(createBody.PrologProcedure).toBe("CubeClearData('Sales');");
        expect(
          fetchSpy.mock.calls.some(([u]) => String(u).includes("tm1.Clear")),
        ).toBe(false);

        const [execUrl] = fetchSpy.mock.calls[1];
        expect(execUrl).toMatch(/Processes\('.*'\)\/tm1\.ExecuteWithReturn$/);

        const [delUrl, delOpts] = fetchSpy.mock.calls[2];
        expect(delOpts.method).toBe("DELETE");
        expect(delUrl).toContain("/Processes('");
      },
    );

    it("clear timeout leaves the temp TI running and says the cube will end up empty", async () => {
      const c = newClient("11.8");
      fetchSpy
        .mockResolvedValueOnce(mock204()) // create process
        .mockImplementationOnce(
          (_u: string, opts: { signal: AbortSignal }) =>
            new Promise((_res, rej) => {
              opts.signal.addEventListener("abort", () =>
                rej(opts.signal.reason as DOMException),
              );
            }),
        ); // execute never answers

      const err = await c.cubes
        .clear("Sales", { timeoutMs: 50 })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "LOCK_TIMEOUT" });
      expect((err as Error).message).toMatch(/keeps running on the server/);
      expect((err as Error).message).toMatch(/Do not retry/);
      // Deleting a TI that still waits on a lock cancels it (12.5), so the
      // temp process must survive a timeout.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect((err as Error).message).toMatch(/}TempClear_Sales_\d+/);
    });

    it("11.x clear: an execute with no status code is not a confirmed clear (T-4)", async () => {
      // `?? "CompletedSuccessfully"` used to report an unverified clear as a
      // successful one. For a destructive operation the unknown has to surface.
      const c = newClient("11.8");
      fetchSpy
        .mockResolvedValueOnce(mock204()) // create process
        .mockResolvedValueOnce(mock204()) // execute — no status code
        .mockResolvedValueOnce(mock204()); // delete (cleanup still runs)

      await expect(c.cubes.clear("Sales")).rejects.toThrow(
        /no ProcessExecuteStatusCode/,
      );

      // The ephemeral process is still cleaned up.
      const [, delOpts] = fetchSpy.mock.calls[2];
      expect(delOpts.method).toBe("DELETE");
    });

    it("11.x clear: a rolled-back clear says the cube is unchanged", async () => {
      // Distinct from the unconfirmed case above: here TM1 told us the writes
      // were discarded, so the caller can be told the cube still holds its
      // data instead of being left to guess.
      const c = newClient("11.8");
      fetchSpy
        .mockResolvedValueOnce(mock204()) // create process
        .mockResolvedValueOnce(
          mockResponse({ ProcessExecuteStatusCode: "Aborted" }),
        ) // execute
        .mockResolvedValueOnce(mock204()); // delete

      await expect(c.cubes.clear("Sales")).rejects.toThrow(
        /rolled back.*Aborted.*unchanged/s,
      );
    });

    it("11.x clear: a committed-with-messages clear stands", async () => {
      // The measured commit semantics say the CubeClearData DID commit. Raising
      // here would tell the model the cube still holds its data when it does
      // not — the inverse of the T-4 fail-open, and just as wrong.
      const c = newClient("11.8");
      fetchSpy
        .mockResolvedValueOnce(mock204()) // create process
        .mockResolvedValueOnce(
          mockResponse({ ProcessExecuteStatusCode: "CompletedWithMessages" }),
        ) // execute
        .mockResolvedValueOnce(mock204()); // delete

      await expect(c.cubes.clear("Sales")).resolves.toBeUndefined();
    });
  });

  // ── feeder / calculation tracing ───────────────────────────────────────────

  describe("cell tracing", () => {
    const cubeMeta = {
      Name: "SalesCube",
      Dimensions: [{ Name: "Time" }, { Name: "Region" }],
    };

    describe("checkFeeders()", () => {
      it("binds the tuple and maps fed-cell descriptors", async () => {
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(
            mockResponse({
              value: [
                {
                  Cube: { Name: "TargetCube" },
                  Tuple: [{ Name: "2024" }, { Name: "EU" }],
                  Fed: true,
                },
                {
                  Cube: { Name: "TargetCube" },
                  Tuple: [{ Name: "2024" }, { Name: "US" }],
                  Fed: false,
                },
              ],
            }),
          );

        const result = await client.cells.checkFeeders("SalesCube", [
          "2024",
          "Total",
        ]);

        expect(result).toEqual([
          { cube: "TargetCube", tuple: ["2024", "EU"], fed: true },
          { cube: "TargetCube", tuple: ["2024", "US"], fed: false },
        ]);

        const [url, opts] = fetchSpy.mock.calls[1];
        expect(url).toContain("/api/v1/Cubes('SalesCube')/tm1.CheckFeeders");
        const body = JSON.parse(opts.body);
        expect(body["Tuple@odata.bind"]).toEqual([
          "Dimensions('Time')/Hierarchies('Time')/Elements('2024')",
          "Dimensions('Region')/Hierarchies('Region')/Elements('Total')",
        ]);
      });

      it("rejects tuple length mismatch without calling the action", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(cubeMeta));

        await expect(
          client.cells.checkFeeders("SalesCube", ["2024"]),
        ).rejects.toThrow(/2 dimension\(s\)/);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it("binds a left-out Sandboxes to Base", async () => {
        fetchSpy
          .mockResolvedValueOnce(
            mockResponse({
              Name: "SalesCube",
              Dimensions: [
                { Name: "Sandboxes" },
                { Name: "Time" },
                { Name: "Region" },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ value: [] }));

        await client.cells.checkFeeders("SalesCube", ["2024", "Total"]);

        const [, opts] = fetchSpy.mock.calls[1];
        expect(JSON.parse(opts.body)["Tuple@odata.bind"]).toEqual([
          "Dimensions('Sandboxes')/Hierarchies('Sandboxes')/Elements('Base')",
          "Dimensions('Time')/Hierarchies('Time')/Elements('2024')",
          "Dimensions('Region')/Hierarchies('Region')/Elements('Total')",
        ]);
      });

      // A bare name means the default hierarchy, which carries the dimension's
      // own name; `Hier:Elem` leaves it. The split takes the FIRST colon, so a
      // colon inside the element name survives and reaches the default
      // hierarchy when it is named explicitly. A colon that cannot separate two
      // names (leading or trailing) is part of the element.
      it.each([
        [
          "Hier:Elem names an alternate hierarchy",
          "Territory:North",
          "Dimensions('Region')/Hierarchies('Territory')/Elements('North')",
        ],
        [
          "a colon-bearing element is reached via its explicit hierarchy",
          "Region:North:West",
          "Dimensions('Region')/Hierarchies('Region')/Elements('North%3AWest')",
        ],
        [
          "a leading colon is part of the element name",
          ":North",
          "Dimensions('Region')/Hierarchies('Region')/Elements('%3ANorth')",
        ],
        [
          "a trailing colon is part of the element name",
          "North:",
          "Dimensions('Region')/Hierarchies('Region')/Elements('North%3A')",
        ],
      ])("%s", async (_label, entry, expectedBind) => {
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(mockResponse({ value: [] }));

        await client.cells.checkFeeders("SalesCube", ["2024", entry]);

        const [, opts] = fetchSpy.mock.calls[1];
        const binds = JSON.parse(opts.body)["Tuple@odata.bind"] as string[];
        expect(binds[1]).toBe(expectedBind);
      });
    });

    describe("traceFeeders()", () => {
      it("maps fed cells and statements", async () => {
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(
            mockResponse({
              FedCells: [
                {
                  Cube: { Name: "SalesCube" },
                  Tuple: [{ Name: "2024" }, { Name: "EU" }],
                  Fed: true,
                },
              ],
              Statements: ["['Units'] => ['Revenue'];"],
            }),
          );

        const result = await client.cells.traceFeeders("SalesCube", [
          "2024",
          "EU",
        ]);

        expect(result.fedCells).toHaveLength(1);
        expect(result.statements).toEqual(["['Units'] => ['Revenue'];"]);
        const [url] = fetchSpy.mock.calls[1];
        expect(url).toContain("/tm1.TraceFeeders");
      });
    });

    describe("traceCellCalculation()", () => {
      it("maps the component tree and truncates by depth and width", async () => {
        const leaf = (n: string, v: number) => ({
          Type: "Simple",
          Status: "Data",
          Value: v,
          Tuple: [{ Name: n }, { Name: "EU" }],
          Components: [],
        });
        fetchSpy
          .mockResolvedValueOnce(mockResponse(cubeMeta))
          .mockResolvedValueOnce(
            mockResponse({
              Type: "Consolidation",
              Status: "Data",
              Value: 6,
              Tuple: [{ Name: "Total" }, { Name: "EU" }],
              Statements: [],
              Components: [
                {
                  Type: "Consolidation",
                  Status: "Data",
                  Value: 5,
                  Tuple: [{ Name: "H1" }, { Name: "EU" }],
                  Components: [leaf("Jan", 2), leaf("Feb", 3)],
                },
                leaf("Adj", 1),
                leaf("Extra", 0),
              ],
            }),
          );

        const tree = await client.cells.traceCellCalculation(
          "SalesCube",
          ["Total", "EU"],
          1,
          2,
        );

        expect(tree.type).toBe("Consolidation");
        expect(tree.value).toBe(6);
        expect(tree.tuple).toEqual(["Total", "EU"]);
        // width: 3 children, maxComponents=2 → 2 kept + truncated flag
        expect(tree.components).toHaveLength(2);
        expect(tree.truncated).toBe(true);
        // depth: maxDepth=1 → grandchildren cut, child marked truncated
        expect(tree.components![0].truncated).toBe(true);
        expect(tree.components![0].components).toBeUndefined();
        const [url] = fetchSpy.mock.calls[1];
        expect(url).toContain("/tm1.TraceCellCalculation");
        expect(url).toContain("Components/Tuple($select=Name)");
      });
    });
  });
});
