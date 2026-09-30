// Live VIEW + SUBSET lifecycle against a real TM1 server. Subsets and views are
// created, read and deleted through tm1_rest_read / tm1_rest_write; the cell
// read of a named view goes through tm1_get_view.
//
// Scaffold: two dimensions + a cube live under the SANDBOX prefix. One D1
// element deliberately contains a single quote to exercise OData literal
// escaping in the Elements@odata.bind path — the subset and native-view
// creates over that element MUST succeed.
//
// Everything created is SANDBOX-prefixed; afterAll tears it down idempotently.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  key,
  LIVE_ENABLED,
  names,
  restGet,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const PFX = `${SANDBOX}_VIEW`;
const D1 = `${PFX}_D1`;
const D2 = `${PFX}_D2`;
const C1 = `${PFX}_C1`;

// Element with a single quote — the OData escaping canary.
const QUOTE_EL = "El'Quote";
const D1_ELEMENTS = ["E1", "E2", QUOTE_EL];
const D2_ELEMENTS = ["M1", "M2"];

const SUBSET = `${PFX}_SUB1`;
const NATIVE_VIEW = `${PFX}_NV1`;
const MDX_VIEW = `${PFX}_MV1`;

// Unencoded hierarchy path, as @odata.bind values carry it.
const bindHier = (d: string) =>
  `Dimensions('${key(d)}')/Hierarchies('${key(d)}')`;
const bindEls = (d: string, els: string[]) =>
  els.map((e) => `${bindHier(d)}/Elements('${key(e)}')`);

const D1_PATH = `${seg("Dimensions", D1)}/${seg("Hierarchies", D1)}`;
const VIEWS = `${seg("Cubes", C1)}/Views`;
const view = (v: string) => `${seg("Cubes", C1)}/${seg("Views", v)}`;

describe.skipIf(!LIVE_ENABLED)("live: view + subset lifecycle", () => {
  let h: LiveHarness;

  const subset = (collection: "Subsets" | "PrivateSubsets") =>
    restGet<{
      Name: string;
      Expression?: string | null;
      Elements: Array<{ Name: string }>;
    }>(
      h,
      `${D1_PATH}/${seg(collection, SUBSET)}?$select=Name,Expression&$expand=Elements($select=Name)`,
    );

  const cleanup = async () => {
    await dropIfExists(h, view(NATIVE_VIEW));
    await dropIfExists(h, view(MDX_VIEW));
    await dropIfExists(h, `${D1_PATH}/${seg("PrivateSubsets", SUBSET)}`);
    await dropIfExists(h, `${D1_PATH}/${seg("Subsets", SUBSET)}`);
    await dropIfExists(h, seg("Cubes", C1));
    await dropIfExists(h, seg("Dimensions", D1));
    await dropIfExists(h, seg("Dimensions", D2));
  };

  beforeAll(async () => {
    h = await getHarness();
    // Clean any leftovers from a crashed prior run so the creates don't 400.
    await cleanup();
    await createDimension(h, D1, D1_ELEMENTS);
    await createDimension(h, D2, D2_ELEMENTS);
    await createCube(h, C1, [D1, D2]);
  });

  afterAll(async () => {
    try {
      await cleanup();
    } catch {
      /* best-effort teardown */
    }
  });

  // ---- Subset lifecycle ----

  it("creates a static public subset over the quoted element", async () => {
    await restWrite(h, "POST", `${D1_PATH}/Subsets`, {
      Name: SUBSET,
      "Elements@odata.bind": bindEls(D1, ["E1", QUOTE_EL]),
    });
    const s = await subset("Subsets");
    expect(s.Elements.map((e) => e.Name)).toEqual(["E1", QUOTE_EL]);
    expect(await names(h, `${D1_PATH}/Subsets`)).toContain(SUBSET);
  });

  it("switches it to an MDX expression that resolves every element", async () => {
    await restWrite(h, "PATCH", `${D1_PATH}/${seg("Subsets", SUBSET)}`, {
      Expression: `{TM1SUBSETALL([${D1}])}`,
    });
    const s = await subset("Subsets");
    expect(s.Expression).toBeTruthy();
    expect(s.Elements.map((e) => e.Name)).toEqual(
      expect.arrayContaining(["E1", "E2", QUOTE_EL]),
    );
  });

  it("a private subset lives beside the public one of the same name", async () => {
    await restWrite(h, "POST", `${D1_PATH}/PrivateSubsets`, {
      Name: SUBSET,
      "Elements@odata.bind": bindEls(D1, [QUOTE_EL]),
    });
    const priv = await subset("PrivateSubsets");
    const pub = await subset("Subsets");
    expect(priv.Elements.map((e) => e.Name)).toEqual([QUOTE_EL]);
    expect(pub.Expression).toBeTruthy();
    await restWrite(h, "DELETE", `${D1_PATH}/${seg("PrivateSubsets", SUBSET)}`);
    const gone = await h.call("tm1_rest_read", {
      path: `${D1_PATH}/${seg("PrivateSubsets", SUBSET)}`,
    });
    expect(gone.isError).toBe(true);
  });

  it("deletes the public subset", async () => {
    await restWrite(h, "DELETE", `${D1_PATH}/${seg("Subsets", SUBSET)}`);
    expect(await names(h, `${D1_PATH}/Subsets`)).not.toContain(SUBSET);
  });

  // ---- Native view (OData quote-escaping on Elements@odata.bind) ----

  it("creates a native view over a quote-containing element", async () => {
    // Rows reference the single-quote element via an explicit element list →
    // Elements@odata.bind path. If OData escaping were wrong, TM1 would 400.
    await restWrite(h, "POST", VIEWS, {
      "@odata.type": "#ibm.tm1.api.v1.NativeView",
      Name: NATIVE_VIEW,
      Rows: [
        {
          Subset: {
            "Hierarchy@odata.bind": bindHier(D1),
            "Elements@odata.bind": bindEls(D1, [QUOTE_EL, "E1"]),
          },
        },
      ],
      Columns: [
        {
          Subset: {
            "Hierarchy@odata.bind": bindHier(D2),
            "Elements@odata.bind": bindEls(D2, ["M1", "M2"]),
          },
        },
      ],
      Titles: [],
      SuppressEmptyColumns: false,
      SuppressEmptyRows: false,
    });
    expect(await names(h, VIEWS)).toContain(NATIVE_VIEW);
  });

  it("get_view executes the native view and returns cells + axes", async () => {
    const r = await h.ok("tm1_get_view", {
      cubeName: C1,
      viewName: NATIVE_VIEW,
    });
    expect(r.json.cubeName).toBe(C1);
    expect(r.json.viewName).toBe(NATIVE_VIEW);
    // get_view returns a page-envelope: cells live under `items` (renamed from
    // `cells` in the 2026-07-01 pagination refactor 1d163e9).
    expect(Array.isArray(r.json.items)).toBe(true);
    expect(Array.isArray(r.json.axes)).toBe(true);
  });

  it("deletes the native view", async () => {
    await restWrite(h, "DELETE", view(NATIVE_VIEW));
    expect(await names(h, VIEWS)).not.toContain(NATIVE_VIEW);
  });

  // ---- MDX view ----

  it("creates an MDX view, reads its MDX back, then deletes it", async () => {
    const mdx = `SELECT {[${D2}].[M1]} ON COLUMNS, {[${D1}].[E1]} ON ROWS FROM [${C1}]`;
    await restWrite(h, "POST", VIEWS, {
      "@odata.type": "#ibm.tm1.api.v1.MDXView",
      Name: MDX_VIEW,
      MDX: mdx,
    });
    const path = view(MDX_VIEW);
    const def = await restGet<{ Name: string; MDX?: string }>(h, path);
    expect(typeof def.MDX).toBe("string");
    expect(def.MDX!.length).toBeGreaterThan(0);

    await restWrite(h, "DELETE", path);
    expect(await names(h, VIEWS)).not.toContain(MDX_VIEW);
  });

  // ---- Negative path ----

  it("reading a nonexistent view returns an error envelope", async () => {
    const r = await h.call("tm1_rest_read", {
      path: view(`${PFX}_DOES_NOT_EXIST`),
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });
});
