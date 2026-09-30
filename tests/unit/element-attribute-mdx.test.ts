import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { mockLogger } from "../helpers/client-harness.js";

function makeConfig(): TM1Config {
  return {
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    logLevel: "info",
  } as unknown as TM1Config;
}

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// getAttributeValues builds MDX by interpolating the dimension and element names
// into bracketed identifiers. Names containing `]` must be doubled (`]]`) or they
// break out of the identifier (MDX injection, M8).
describe("ElementService.getAttributeValues — MDX identifier escaping (M8)", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    const config = makeConfig();
    const sessionManager = new SessionManager(config, mockLogger);
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "authenticate").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sessionManager, "stopKeepAlive").mockImplementation(() => {});
    client = new TM1Client(config, sessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The attribute cube spans every hierarchy of the dimension. Measured: v12
  // refuses a bare name another hierarchy shares ("Member name A is
  // ambiguous"), and v11 finds a bare name only in the default hierarchy.
  const mdxOf = (call: unknown[]) =>
    (JSON.parse(String((call[1] as { body: string }).body)) as { MDX: string })
      .MDX;

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

  it("refuses an unknown attribute and names the existing ones", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ value: [{ Name: "Caption", Type: "String" }] }),
    );
    await expect(
      client.elements.updateAttributeValue("Region", "North", "Nope", "N"),
    ).rejects.toThrow(/'Nope' does not exist.*Existing: Caption/);
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
