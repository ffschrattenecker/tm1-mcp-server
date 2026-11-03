// Live integration: the hierarchy read path behind the cross-connection
// comparison tools. The harness has one connection, so comparing the live model
// with itself is the only identity check available; this file keeps the one
// case that exercises paging against the real server. Strictly read-only.
import { describe, it, expect, beforeAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  restGet,
  type LiveHarness,
} from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: cross-connection compare", () => {
  let h: LiveHarness;
  let dimension: string | undefined;

  beforeAll(async () => {
    h = await getHarness();
    dimension = (
      await restGet<Array<{ Name: string }>>(
        h,
        "Dimensions?$select=Name&$filter=not startswith(Name,'}')&$top=1",
      )
    )[0]?.Name;
  });

  it("getStructure: small pages stitch to the single-page read", async () => {
    if (!dimension) return;
    const read = (pageSize?: number) =>
      h.client.hierarchies.getStructure(dimension!, dimension!, pageSize);
    const whole = await read();
    const paged = await read(Math.max(1, Math.ceil(whole.elements.length / 4)));
    const names = paged.elements.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    const sorted = (s: typeof whole) => ({
      elements: s.elements.map((e) => e.name).sort(),
      edges: s.edges.map((e) => `${e.parent}>${e.child}:${e.weight}`).sort(),
    });
    expect(sorted(paged)).toEqual(sorted(whole));
  });
});
