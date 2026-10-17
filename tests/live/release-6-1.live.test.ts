// Live checks for tm1_search_elements: the MDX FILTER it runs on the server,
// the exact total next to a capped list, and the cube-wide scope.
//
// Every object is SANDBOX-prefixed and removed in afterAll (sweepSandbox in
// global-setup is the safety net).
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const DIM = `${SANDBOX}_SE_DIM`;
const OTHER = `${SANDBOX}_SE_OTHER`;
const CUBE = `${SANDBOX}_SE_CUBE`;

describe.skipIf(!LIVE_ENABLED)("live: tm1_search_elements", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    await dropIfExists(h, seg("Cubes", CUBE));
    await dropIfExists(h, seg("Dimensions", DIM));
    await dropIfExists(h, seg("Dimensions", OTHER));
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, DIM, ["Harbor_North", "HARBOR_South", "Inland"]);
    await createDimension(h, OTHER, ["Harbor_Total", "Rest"]);
    await createCube(h, CUBE, [DIM, OTHER]);
  });

  afterAll(cleanup);

  it("matches names case-insensitively and counts past topN", async () => {
    const r = await h.ok("tm1_search_elements", {
      searchTerm: "harbor",
      dimensionName: DIM,
      topN: 1,
    });
    const [hit] = r.json.dimensions;
    expect(hit.total).toBe(2);
    expect(hit.truncated).toBe(true);
    expect(hit.elements).toHaveLength(1);
    expect(hit.elements[0].matchedOn).toBe("Name");
  });

  it("searches every dimension of a cube and omits those without hits", async () => {
    const r = await h.ok("tm1_search_elements", {
      searchTerm: "harbor",
      cubeName: CUBE,
    });
    const found = r.json.dimensions.map(
      (d: { dimension: string }) => d.dimension,
    );
    expect(found.sort()).toEqual([DIM, OTHER].sort());
    const none = await h.ok("tm1_search_elements", {
      searchTerm: "no_such_term_zz",
      cubeName: CUBE,
    });
    expect(none.json.dimensions).toEqual([]);
  });
});
