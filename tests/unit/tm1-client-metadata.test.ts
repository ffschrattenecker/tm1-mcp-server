import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { type TM1Client } from "../../src/tm1-client.js";

import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockResponse, stubbedClient } from "../helpers/client-harness.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – Metadata Methods", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);

    const config = makeTestConfig({ requestTimeoutMs: 5000 });
    client = stubbedClient(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── getCubes() ─────────────────────────────────────────────────────────────

  describe("cubes.list()", () => {
    it("should return cubes with name and dimension names", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "SalesCube",
              Dimensions: [
                { Name: "Region" },
                { Name: "Product" },
                { Name: "Time" },
              ],
            },
            {
              Name: "PlanCube",
              Dimensions: [{ Name: "Account" }, { Name: "Time" }],
            },
          ],
        }),
      );

      const cubes = await client.cubes.list();

      expect(cubes).toEqual([
        { name: "SalesCube", dimensions: ["Region", "Product", "Time"] },
        { name: "PlanCube", dimensions: ["Account", "Time"] },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      // Light path pins $select=Name so TM1 doesn't ship every cube's Rules blob.
      expect(url).toContain(
        "/api/v1/Cubes?$select=Name&$expand=Dimensions($select=Name)",
      );
      expect(String(url)).toContain("$select=Name");
    });

    it("should return empty array when no cubes exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const cubes = await client.cubes.list();
      expect(cubes).toEqual([]);
    });

    it("should still request Rules when includeRules=true (hasRules derivation)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "SalesCube",
              Rules: "SKIPCHECK;\nFEEDERS;",
              Dimensions: [{ Name: "Region" }],
            },
            { Name: "PlanCube", Rules: "", Dimensions: [{ Name: "Time" }] },
          ],
        }),
      );

      const cubes = await client.cubes.list({ includeRules: true });

      expect(cubes).toEqual([
        { name: "SalesCube", dimensions: ["Region"], hasRules: true },
        { name: "PlanCube", dimensions: ["Time"], hasRules: false },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain(
        "/api/v1/Cubes?$select=Name,Rules&$expand=Dimensions($select=Name)",
      );
    });
  });

  // ── getDimensions() ────────────────────────────────────────────────────────

  describe("dimensions.list()", () => {
    it("should return dimensions with name and hierarchy names", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "Region",
              Hierarchies: [{ Name: "Region" }, { Name: "Country" }],
            },
            { Name: "Time", Hierarchies: [{ Name: "Time" }] },
          ],
        }),
      );

      const dims = await client.dimensions.list();

      expect(dims).toEqual([
        { name: "Region", hierarchies: ["Region", "Country"] },
        { name: "Time", hierarchies: ["Time"] },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain(
        "/api/v1/Dimensions?$expand=Hierarchies($select=Name)",
      );
    });

    it("should return empty array when no dimensions exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const dims = await client.dimensions.list();
      expect(dims).toEqual([]);
    });

    it("should include elementCounts when includeElementCount=true", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "Region",
              Hierarchies: [
                { Name: "Region", "Elements@odata.count": 12 },
                { Name: "Country", "Elements@odata.count": 195 },
              ],
            },
            {
              Name: "Time",
              Hierarchies: [{ Name: "Time", "Elements@odata.count": 24 }],
            },
          ],
        }),
      );

      const dims = await client.dimensions.list({ includeElementCount: true });

      expect(dims).toEqual([
        {
          name: "Region",
          hierarchies: ["Region", "Country"],
          elementCounts: { Region: 12, Country: 195 },
        },
        {
          name: "Time",
          hierarchies: ["Time"],
          elementCounts: { Time: 24 },
        },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("$expand=Elements($count=true;$top=0)");
    });

    it("should default missing Elements@odata.count to 0", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [{ Name: "Empty", Hierarchies: [{ Name: "Empty" }] }],
        }),
      );

      const dims = await client.dimensions.list({ includeElementCount: true });
      expect(dims[0].elementCounts).toEqual({ Empty: 0 });
    });
  });

  // ── getElementTypes() ──────────────────────────────────────────────────────

  describe("hierarchies.getElementTypes()", () => {
    it("should read Name,Type from Elements without expanding Parents", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            { Name: "Total", Type: "Consolidated" },
            { Name: "DE", Type: "Numeric" },
          ],
        }),
      );

      const elements = await client.hierarchies.getElementTypes(
        "Region",
        "Region",
      );

      expect(elements).toEqual([
        { name: "Total", type: "Consolidated" },
        { name: "DE", type: "Numeric" },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const decoded = decodeURIComponent(fetchSpy.mock.calls[0][0] as string);
      expect(decoded).toContain(
        "Dimensions('Region')/Hierarchies('Region')/Elements",
      );
      expect(decoded).toContain("$select=Name,Type");
      expect(decoded).not.toContain("$expand");
    });

    it("should encode special characters and tolerate a missing value array", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({}));

      const elements = await client.hierarchies.getElementTypes(
        "My Dim",
        "My Hier",
      );

      expect(elements).toEqual([]);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Dimensions('My%20Dim')");
      expect(url).toContain("Hierarchies('My%20Hier')");
    });
  });

  // ── getProcesses() ─────────────────────────────────────────────────────────

  describe("processes.list()", () => {
    it("should return processes with mapped parameters", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "ImportData",
              Parameters: [
                {
                  Name: "pFilePath",
                  Type: "String",
                  Value: "/data/input.csv",
                  Prompt: "File path",
                },
                { Name: "pYear", Type: "Numeric", Value: 2024 },
              ],
            },
            {
              Name: "ExportReport",
              Parameters: [],
            },
          ],
        }),
      );

      const processes = await client.processes.list();

      expect(processes).toEqual([
        {
          name: "ImportData",
          parameters: [
            {
              name: "pFilePath",
              type: "String",
              defaultValue: "/data/input.csv",
              prompt: "File path",
            },
            { name: "pYear", type: "Numeric", defaultValue: 2024 },
          ],
        },
        {
          name: "ExportReport",
          parameters: [],
        },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes?$select=Name,Parameters");
    });

    it("should map Type 'Numeric' / 'String' from TM1 v11 API", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "TestProc",
              Parameters: [
                { Name: "numParam", Type: "Numeric", Value: 42 },
                { Name: "strParam", Type: "String", Value: "hello" },
              ],
            },
          ],
        }),
      );

      const processes = await client.processes.list();
      expect(processes[0].parameters[0].type).toBe("Numeric");
      expect(processes[0].parameters[1].type).toBe("String");
    });

    it("should return empty array when no processes exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const processes = await client.processes.list();
      expect(processes).toEqual([]);
    });
  });

  // ── getChores() ────────────────────────────────────────────────────────────

  describe("chores.list()", () => {
    it("should return chores with tasks mapped to processes", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "NightlyImport",
              Active: true,
              StartTime: "2024-01-01T02:00:00",
              DSTSensitive: false,
              Frequency: "P1D",
              Tasks: [
                {
                  Process: { Name: "ImportData" },
                  Parameters: [
                    { Name: "pFilePath", Value: "/data/nightly.csv" },
                    { Name: "pYear", Value: 2024 },
                  ],
                },
                {
                  Process: { Name: "RunCalc" },
                  Parameters: [],
                },
              ],
            },
          ],
        }),
      );

      const chores = await client.chores.list();

      expect(chores).toEqual([
        {
          name: "NightlyImport",
          active: true,
          startTime: "2024-01-01T02:00:00",
          frequency: "P1D",
          processes: [
            {
              name: "ImportData",
              parameters: { pFilePath: "/data/nightly.csv", pYear: 2024 },
            },
            { name: "RunCalc", parameters: {} },
          ],
        },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Chores?$expand=Tasks");
    });

    it("should return empty array when no chores exist", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const chores = await client.chores.list();
      expect(chores).toEqual([]);
    });

    it("should handle chore with no tasks", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            {
              Name: "EmptyChore",
              Active: false,
              StartTime: "2024-06-01T00:00:00",
              DSTSensitive: true,
              Frequency: "P7D",
              Tasks: [],
            },
          ],
        }),
      );

      const chores = await client.chores.list();
      expect(chores[0].processes).toEqual([]);
      expect(chores[0].active).toBe(false);
    });
  });
});
