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
  storageMatchesDisplayOrder,
  validateStorageDimensionOrder,
} from "../../src/lib/cube-stats/dimension-order-helper.js";
import { registerGetCubeStats } from "../../src/tools/operations/get-cube-stats.js";
import { registerReorderCubeDimensions } from "../../src/tools/model-building/reorder-cube-dimensions.js";
import { CubeStatsResultSchema } from "../../src/tools/schemas/items.js";

describe("dimension-order helpers", () => {
  it("storageMatchesDisplayOrder ignores leading Sandboxes in display order", () => {
    expect(
      storageMatchesDisplayOrder(
        ["Sandboxes", "Time", "Region"],
        ["Time", "Region"],
      ),
    ).toBe(true);
    expect(
      storageMatchesDisplayOrder(
        ["Sandboxes", "Time", "Region"],
        ["Region", "Time"],
      ),
    ).toBe(false);
  });

  it("validateStorageDimensionOrder rejects Sandboxes, duplicates, missing, and unknown dimensions", () => {
    expect(() =>
      validateStorageDimensionOrder(
        ["Time", "Region"],
        ["Sandboxes", "Time", "Region"],
      ),
    ).toThrow(/Sandboxes/);
    expect(() =>
      validateStorageDimensionOrder(["Time", "Region"], ["Time", "Time"]),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateStorageDimensionOrder(["Time", "Region"], ["Time", "Bogus"]),
    ).toThrow(/unknown: Bogus; missing: Region/);
    expect(
      validateStorageDimensionOrder(["Time", "Region"], ["region", "time"]),
    ).toEqual({ canonical: ["Region", "Time"], changed: true });
  });
});

describe("tm1_get_cube_stats with includeDimensionOrder", () => {
  it("does not query dimension order when includeDimensionOrder is omitted/false", async () => {
    const getDimensionNames = vi.fn();
    const getDimensionsStorageOrder = vi.fn();
    const client = {
      version: 11,
      cubes: { getDimensionNames, getDimensionsStorageOrder, exists: vi.fn() },
      cells: {
        executeMdx: vi.fn().mockResolvedValue({
          axes: [
            { tuples: [] },
            { tuples: [{ members: [{ name: "Total Memory Used" }] }] },
          ],
          cells: [{ value: 1024, formattedValue: "1024" }],
        }),
      },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerGetCubeStats, client);
    await call({ cubeName: "Sales" });
    expect(getDimensionNames).not.toHaveBeenCalled();
    expect(getDimensionsStorageOrder).not.toHaveBeenCalled();
  });

  it("returns displayOrder/storageOrder on v12 even when }StatsByCube is absent", async () => {
    const client = {
      version: 12,
      cubes: {
        exists: vi.fn().mockResolvedValue(false),
        getDimensionNames: vi
          .fn()
          .mockResolvedValue(["Sandboxes", "Time", "Region"]),
        getDimensionsStorageOrder: vi
          .fn()
          .mockResolvedValue(["Region", "Time"]),
      },
      cells: {
        executeMdx: vi
          .fn()
          .mockRejectedValue(
            new Error('There is no cube named "}StatsByCube".'),
          ),
      },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerGetCubeStats, client);
    const res = (await call({
      cubeName: "Sales",
      includeDimensionOrder: true,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0].text);

    expect(() => CubeStatsResultSchema.parse(payload)).not.toThrow();
    expect(payload.statsUnavailable).toMatchObject({ reason: "absent" });
    expect(payload.items[0]).toMatchObject({
      cubeName: "Sales",
      displayOrder: ["Sandboxes", "Time", "Region"],
      storageOrder: ["Region", "Time"],
      storageMatchesDisplay: false,
    });
  });
});

describe("tm1_reorder_cube_dimensions", () => {
  let fetchSpy: FnSpy;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dryRun=true inspects sizes and validates order without calling tm1.ReorderDimensions", async () => {
    const reorderDimensions = vi.fn();
    const client = {
      version: 12,
      cubes: {
        exists: vi.fn().mockResolvedValue(false),
        getDimensionNames: vi.fn().mockResolvedValue(["Time", "Region"]),
        getDimensionsStorageOrder: vi
          .fn()
          .mockResolvedValue(["Time", "Region"]),
        reorderDimensions,
      },
      dimensions: {
        list: vi.fn().mockResolvedValue([
          { name: "Time", hierarchies: ["Time"], elementCounts: { Time: 24 } },
          {
            name: "Region",
            hierarchies: ["Region"],
            elementCounts: { Region: 5 },
          },
        ]),
      },
      cells: { executeMdx: vi.fn().mockRejectedValue(new Error("no stats")) },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerReorderCubeDimensions, client);
    const res = (await call({
      cubeName: "Sales",
      dimensionOrder: ["Region", "Time"],
      dryRun: true,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0].text);

    expect(reorderDimensions).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      success: true,
      dryRun: true,
      cubeName: "Sales",
      currentStorageOrder: ["Time", "Region"],
      proposedOrder: ["Region", "Time"],
      wouldChange: true,
      suggestedBySize: ["Region", "Time"],
    });
  });

  it("dryRun=false short-circuits when order is already identical", async () => {
    const reorderDimensions = vi.fn();
    const client = {
      version: 11,
      cubes: {
        getDimensionNames: vi.fn().mockResolvedValue(["Time", "Region"]),
        getDimensionsStorageOrder: vi
          .fn()
          .mockResolvedValue(["Time", "Region"]),
        reorderDimensions,
      },
      cells: { executeMdx: vi.fn() },
    } as unknown as TM1Client;

    const call = captureParsedTool(registerReorderCubeDimensions, client);
    const res = (await call({
      cubeName: "Sales",
      dimensionOrder: ["Time", "Region"],
      dryRun: false,
      measureMemory: false,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0].text);

    expect(reorderDimensions).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      success: true,
      changed: false,
      percentMemoryChange: 0,
    });
  });

  it("request shape: dryRun=false posts Dimensions@odata.bind to tm1.ReorderDimensions and reads back storage order", async () => {
    const client = stubbedClient(makeTestConfig({ version: 11 }));
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({
          Name: "Sales",
          Dimensions: [{ Name: "Time" }, { Name: "Region" }],
        }),
      ) // getDimensionNames
      .mockResolvedValueOnce(
        mockResponse({ value: [{ Name: "Time" }, { Name: "Region" }] }),
      ) // getDimensionsStorageOrder before
      .mockResolvedValueOnce(mockResponse({ value: -18.5 })) // tm1.ReorderDimensions
      .mockResolvedValueOnce(
        mockResponse({ value: [{ Name: "Region" }, { Name: "Time" }] }),
      ); // getDimensionsStorageOrder after

    const call = captureParsedTool(registerReorderCubeDimensions, client);
    const res = (await call({
      cubeName: "Sales",
      dimensionOrder: ["Region", "Time"],
      dryRun: false,
      measureMemory: false,
    })) as { content: Array<{ text: string }> };

    const [reorderUrl, reorderOpts] = fetchSpy.mock.calls[2] as [
      string,
      { method: string; body: string },
    ];
    expect(reorderOpts.method).toBe("POST");
    expect(reorderUrl).toContain(
      "/api/v1/Cubes('Sales')/tm1.ReorderDimensions",
    );
    expect(JSON.parse(reorderOpts.body)).toEqual({
      "Dimensions@odata.bind": ["Dimensions('Region')", "Dimensions('Time')"],
    });

    const payload = JSON.parse(res.content[0].text);
    expect(payload).toMatchObject({
      success: true,
      dryRun: false,
      changed: true,
      previousStorageOrder: ["Time", "Region"],
      storageOrder: ["Region", "Time"],
      percentMemoryChange: -18.5,
    });
  });
});
