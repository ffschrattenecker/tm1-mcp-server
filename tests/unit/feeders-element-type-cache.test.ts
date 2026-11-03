import { describe, it, expect, vi } from "vitest";
import type { FnSpy } from "../helpers/spy-types.js";
import { ElementTypeCache } from "../../src/lib/feeders/element-type-cache.js";

interface HierarchyMock {
  getElementTypes: FnSpy;
}

function makeHierarchyMock(
  map: Record<string, Array<{ name: string; type: string }>>,
): HierarchyMock {
  return {
    getElementTypes: vi.fn(async (dim: string, hier: string) => {
      const key = `${dim}|${hier}`;
      return (map[key] ?? []).map((e) => ({ name: e.name, type: e.type }));
    }),
  };
}

describe("ElementTypeCache", () => {
  it("returns element type via hierarchy fetch", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [
        { name: "Total", type: "Consolidated" },
        { name: "DE", type: "Numeric" },
      ],
    });
    const cache = new ElementTypeCache(hier);

    expect(await cache.getType("Region", "Region", "Total")).toBe(
      "Consolidated",
    );
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
  });

  it("returns null for unknown elements", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier);
    expect(await cache.getType("Region", "Region", "ZZ")).toBeNull();
  });

  it("caches (dim, hier) — only one REST call per pair", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier);
    await cache.getType("Region", "Region", "DE");
    await cache.getType("Region", "Region", "DE");
    await cache.getType("Region", "Region", "FR");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
    expect(hier.getElementTypes).toHaveBeenCalledWith("Region", "Region");
  });

  it("element names case-insensitive on lookup (TM1 semantics)", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier);
    expect(await cache.getType("Region", "Region", "de")).toBe("Numeric");
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
  });

  it("dim/hier names case-insensitive — same underlying cache slot", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier);
    await cache.getType("region", "REGION", "DE");
    await cache.getType("Region", "Region", "DE");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
  });

  it("returns null and does not throw when hierarchy fetch fails", async () => {
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        throw new Error("hier 404");
      }),
    };
    const cache = new ElementTypeCache(hier);
    expect(await cache.getType("Bogus", "Bogus", "X")).toBeNull();
  });

  it("does not cache a failed load — a later call retries and can succeed", async () => {
    let calls = 0;
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("transient timeout");
        return [{ name: "DE", type: "Numeric" }];
      }),
    };
    const cache = new ElementTypeCache(hier);

    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(2);

    // …and the successful load is cached from then on.
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share a single failing load attempt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        await gate;
        throw new Error("hier 500");
      }),
    };
    const cache = new ElementTypeCache(hier);

    const inflight = Promise.all([
      cache.getType("Region", "Region", "DE"),
      cache.getType("Region", "Region", "FR"),
      cache.getType("region", "region", "IT"),
    ]);
    release();
    expect(await inflight).toEqual([null, null, null]);
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
  });

  // Each slot gives up after 3 consecutive failures and stops issuing requests,
  // which bounds a per-feeder-entry loop to 3 failing calls. Two failures that
  // precede a success must not pin the slot: the success is cached.
  it("gives up and heals per slot", async () => {
    const attempts: Record<string, number> = {};
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async (dim: string) => {
        attempts[dim] = (attempts[dim] ?? 0) + 1;
        // Deterministic failure, e.g. TM1's HTTP 400 ObjectSecurityNoReadRights
        // for a dimension the auditing user may not read.
        if (dim === "Region") throw new Error("ObjectSecurityNoReadRights");
        // Transient failures that clear before the budget runs out.
        if (dim === "Flaky" && attempts[dim] <= 2) throw new Error("transient");
        return [{ name: "P1", type: "Numeric" }];
      }),
    };
    const cache = new ElementTypeCache(hier);

    // Region: failures 1 and 2 retry, the 3rd pins the slot to null.
    for (let i = 0; i < 3; i++) {
      expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    }
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);
    // No further requests however many lookups follow.
    for (let i = 0; i < 25; i++) {
      expect(await cache.getType("Region", "Region", `E${i}`)).toBeNull();
    }
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);

    // Flaky: two failures, then the third attempt succeeds and is cached.
    expect(await cache.getType("Flaky", "Flaky", "P1")).toBeNull();
    expect(await cache.getType("Flaky", "Flaky", "P1")).toBeNull();
    expect(await cache.getType("Flaky", "Flaky", "P1")).toBe("Numeric");
    expect(await cache.getType("Flaky", "Flaky", "P1")).toBe("Numeric");
    expect(attempts.Flaky).toBe(3);
  });

  it("normalizes type strings unknown to TM1 to null", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "Weird", type: "SomethingElse" }],
    });
    const cache = new ElementTypeCache(hier);
    expect(await cache.getType("Region", "Region", "Weird")).toBeNull();
  });
});
