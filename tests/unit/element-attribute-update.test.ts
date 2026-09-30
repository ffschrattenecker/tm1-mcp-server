import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import { registerUpdateElementAttributeValue } from "../../src/tools/dimension-management/update-element-attribute-value.js";
import { TM1Error } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import {
  captureParsedTool,
  mockResponse,
  stubbedClient,
} from "../helpers/client-harness.js";

type Written = {
  cube: string;
  dims: string[];
  cells: Array<{ elements: string[]; value: number | string }>;
};

function makeService(written: Written[]) {
  const http = {
    request: async () => ({
      value: [
        { Name: "Weight", Type: "Numeric" },
        { Name: "Caption", Type: "String" },
        { Name: "Code", Type: "Alias" },
      ],
    }),
  };
  const cells = {
    writeCells: async (
      cube: string,
      dims: string[],
      c: Written["cells"],
    ): Promise<void> => {
      written.push({ cube, dims, cells: c });
    },
  };
  return new ElementService(
    http as unknown as ConstructorParameters<typeof ElementService>[0],
    cells as unknown as ConstructorParameters<typeof ElementService>[1],
  );
}

function handlerFor(elements: unknown) {
  const h = captureParsedTool(registerUpdateElementAttributeValue, {
    elements,
  } as unknown as TM1Client);
  return (args: Record<string, unknown>) => h(args);
}

describe("ElementService.updateAttributeValues", () => {
  it("writes every update in one cellset write, coerced to the attribute type", async () => {
    const written: Written[] = [];
    await makeService(written).updateAttributeValues("Region", [
      { elementName: "AT", attributeName: "Weight", value: " 12.5 " },
      { elementName: "AT", attributeName: "Caption", value: "Austria" },
      { elementName: "DE", attributeName: "Code", value: 49 },
    ]);
    expect(written).toHaveLength(1);
    expect(written[0].cube).toBe("}ElementAttributes_Region");
    expect(written[0].dims).toEqual(["Region", "}ElementAttributes_Region"]);
    expect(written[0].cells).toEqual([
      { elements: ["[Region].[Region].[AT]", "Weight"], value: 12.5 },
      { elements: ["[Region].[Region].[AT]", "Caption"], value: "Austria" },
      { elements: ["[Region].[Region].[DE]", "Code"], value: "49" },
    ]);
  });

  it("rejects a non-numeric value for a Numeric attribute before writing", async () => {
    const written: Written[] = [];
    const err = await makeService(written)
      .updateAttributeValues("Region", [
        { elementName: "AT", attributeName: "Weight", value: "heavy" },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).message).toContain("is Numeric");
    expect(written).toEqual([]);
  });

  it("names the known attributes when one does not exist", async () => {
    const err = await makeService([])
      .updateAttributeValue("Region", "AT", "Colour", "red")
      .catch((e: unknown) => e);
    expect((err as TM1Error).code).toBe("NOT_FOUND");
    expect((err as TM1Error).message).toContain("'Colour' does not exist");
    expect((err as TM1Error).message).toContain(
      "Existing: Weight, Caption, Code",
    );
  });
});

// Through a full TM1Client: the attribute list is read first, then the value is
// written as a cellset.
describe("ElementService.updateAttributeValue — REST round-trip", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    client = stubbedClient(makeTestConfig({ requestTimeoutMs: 5_000 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const mdxOf = (call: unknown[]) =>
    (JSON.parse(String((call[1] as { body: string }).body)) as { MDX: string })
      .MDX;

  // The attribute cube spans every hierarchy of the dimension. Measured: v12
  // refuses a bare name another hierarchy shares ("Member name A is
  // ambiguous"), and v11 finds a bare name only in the default hierarchy.
  it("writes to an element of an alternate hierarchy", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ value: [{ Name: "Caption", Type: "String" }] }),
    );
    fetchSpy.mockResolvedValueOnce(mockResponse({ ID: "cs-1" }));
    fetchSpy.mockResolvedValue(mockResponse({}));
    await client.elements.updateAttributeValue(
      "Region",
      "North",
      "Caption",
      "N",
      "Alt",
    );
    expect(mdxOf(fetchSpy.mock.calls[1])).toContain("[Region].[Alt].[North]");
  });

  it("refuses to write when the dimension has no attributes", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));
    await expect(
      client.elements.updateAttributeValue("Region", "North", "Caption", "N"),
    ).rejects.toThrow(/has no attributes/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("matches the attribute name ignoring case and spaces, as TM1 does", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ value: [{ Name: "Caption Text", Type: "String" }] }),
    );
    fetchSpy.mockResolvedValueOnce(mockResponse({ ID: "cs-1" }));
    fetchSpy.mockResolvedValue(mockResponse({}));
    await client.elements.updateAttributeValue(
      "Region",
      "North",
      "captiontext",
      "N",
    );
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("tm1_update_element_attribute_value", () => {
  it("accepts a bare number for value and hands it on as text", async () => {
    const seen: unknown[][] = [];
    const call = handlerFor({
      updateAttributeValue: async (...a: unknown[]) => void seen.push(a),
    });
    await call({
      dimensionName: "Region",
      elementName: "AT",
      attributeName: "Weight",
      value: 3,
    });
    expect(seen).toEqual([["Region", "AT", "Weight", "3", undefined]]);
  });

  it("routes updates[] to the batch write", async () => {
    const seen: unknown[][] = [];
    const call = handlerFor({
      updateAttributeValues: async (...a: unknown[]) => void seen.push(a),
    });
    const out = (await call({
      dimensionName: "Region",
      updates: [{ elementName: "AT", attributeName: "Weight", value: "1" }],
    })) as { structuredContent: { updated: number } };
    expect(seen).toHaveLength(1);
    expect(out.structuredContent.updated).toBe(1);
  });

  it("rejects mixing updates[] with the single-value fields", async () => {
    const call = handlerFor({});
    await expect(
      call({
        dimensionName: "Region",
        elementName: "AT",
        updates: [{ elementName: "AT", attributeName: "W", value: "1" }],
      }),
    ).rejects.toThrow(/not both/);
  });

  it("rejects an incomplete single-value call", async () => {
    const call = handlerFor({});
    await expect(
      call({ dimensionName: "Region", elementName: "AT" }),
    ).rejects.toThrow(/all required/);
  });
});
