import { describe, it, expect, vi } from "vitest";
import { DimensionOrderCache } from "../../src/tm1-client/services/dimension-order.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { Tm1MutationEvent } from "../../src/lib/tm1-events.js";

function fakeHttp() {
  const listeners: Array<(e: Tm1MutationEvent) => void> = [];
  const request = vi.fn(async () => ({
    Dimensions: [{ Name: "Product" }, { Name: "Measure" }],
  }));
  const http = {
    request,
    onMutation: (l: (e: Tm1MutationEvent) => void) => listeners.push(l),
  } as unknown as TM1HttpClient;
  const mutate = (method: string, path: string) =>
    listeners.forEach((l) => l({ method, path }));
  return { http, request, mutate };
}

describe("DimensionOrderCache", () => {
  it("fetches once per cube, keyed case- and space-insensitively", async () => {
    const { http, request } = fakeHttp();
    const cache = new DimensionOrderCache(http);
    expect(await cache.get("Sales Plan")).toEqual(["Product", "Measure"]);
    await cache.get("salesplan");
    await Promise.all([cache.get("SALES PLAN"), cache.get("Sales Plan")]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("survives the cell read/write hot path", async () => {
    const { http, request, mutate } = fakeHttp();
    const cache = new DimensionOrderCache(http);
    await cache.get("Sales");
    mutate("POST", "/api/v1/ExecuteMDX");
    mutate("PATCH", "/api/v1/Cellsets('cs1')/Cells");
    mutate("DELETE", "/api/v1/Cellsets('cs1')");
    await cache.get("Sales");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("clears on any other mutation — a TI run may have rebuilt the cube", async () => {
    const { http, request, mutate } = fakeHttp();
    const cache = new DimensionOrderCache(http);
    await cache.get("Sales");
    mutate("POST", "/api/v1/Processes('rebuild')/tm1.ExecuteWithReturn");
    await cache.get("Sales");
    mutate("DELETE", "/api/v1/Cubes('Sales')");
    await cache.get("Sales");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("expires after the TTL, for changes made by other clients", async () => {
    const { http, request } = fakeHttp();
    let t = 0;
    const cache = new DimensionOrderCache(http, () => t);
    await cache.get("Sales");
    t = 59_999;
    await cache.get("Sales");
    t = 60_000;
    await cache.get("Sales");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const { http, request } = fakeHttp();
    request.mockRejectedValueOnce(new Error("boom"));
    const cache = new DimensionOrderCache(http);
    await expect(cache.get("Sales")).rejects.toThrow("boom");
    expect(await cache.get("Sales")).toEqual(["Product", "Measure"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
