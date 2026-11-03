// Live lifecycle test for the DIMENSION / ELEMENT / ATTRIBUTE domain. Drives
// the real MCP tool layer against a running TM1 server through a full
// create → read → update → attribute → delete cycle: the object CRUD goes
// through tm1_rest_read / tm1_rest_write, the element and attribute writes
// through the dedicated tools. Every object is prefixed with SANDBOX so it can
// never collide with real model objects, and afterAll drops the dimension so a
// mid-test failure still cleans up.
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  names,
  restGet,
  restWrite,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";

const DIM = `${SANDBOX}_DIM_A`;
const HIER = DIM; // default hierarchy shares the dimension name
const ALT_HIER = `${SANDBOX}_DIM_A_ALT`;
// Single-quote in the name exercises OData literal quote-escaping end-to-end.
const QUOTE_EL = `${SANDBOX}_DIM_A_X'Y`;

const TOP = "Total"; // consolidated root
const SUB = "Region_North"; // intermediate consolidation
const LEAF1 = "City_A"; // leaf under SUB
const LEAF2 = "City_B"; // leaf added by the bulk upsert
const LEAF3 = "City_C"; // leaf for attribute values
const TC = "TypeChangeLeaf"; // standalone leaf for the upsert idempotency / type-change test

const HIER_PATH = `${seg("Dimensions", DIM)}/${seg("Hierarchies", HIER)}`;

describe.skipIf(!LIVE_ENABLED)(
  "live: dimension / element / attribute lifecycle",
  () => {
    let h: LiveHarness;

    // The weight TM1 stores on the edge parent → child.
    const edgeWeight = async (parent: string, child: string) => {
      const edges = await restGet<
        Array<{ ParentName: string; ComponentName: string; Weight: number }>
      >(h, `${HIER_PATH}/Edges`);
      return edges.find(
        (e) => e.ParentName === parent && e.ComponentName === child,
      )?.Weight;
    };

    beforeAll(async () => {
      h = await getHarness();
      // Defensive: drop a stale sandbox dim from a crashed prior run.
      await dropIfExists(h, seg("Dimensions", DIM));
    });

    afterAll(async () => {
      // Deleting the dimension cascades hierarchies, elements and attributes.
      try {
        await dropIfExists(h, seg("Dimensions", DIM));
      } catch {
        /* best-effort teardown */
      }
    });

    it("creates a dimension with leaf, quoted and weighted elements", async () => {
      await createDimension(h, DIM, [
        LEAF1,
        // Element whose name contains a single quote — OData escaping path.
        QUOTE_EL,
        // Weight deliberately NOT 1: 1 is what a missing edge falls back to,
        // so a test built on it cannot tell a real weight from a lost one.
        { name: SUB, children: [{ name: LEAF1, weight: -1 }] },
      ]);
      expect(await names(h, "Dimensions", DIM)).toContain(DIM);
    });

    it("stores the real edge weight, not the fallback", async () => {
      // -1 is the case that matters in practice (P&L dimensions that net
      // costs against revenue).
      expect(await edgeWeight(SUB, LEAF1)).toBe(-1);
    });

    it("bulk_upsert_elements keeps a weight that is not 1", async () => {
      // The bulk path builds hierarchies wholesale and had the same defect the
      // single-element path was fixed for: TM1 takes `Weight` inside the
      // Components link and ignores it, so every edge landed at 1. Found by
      // driving the tool by hand against 11.8 — a component asked for at -1
      // read back as +1, which inverts a netting consolidation without a word.
      const BULK_C = `${SANDBOX}_BULK_C`;
      await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM,
        hierarchyName: HIER,
        elements: [
          { name: LEAF1, type: "Numeric" },
          { name: LEAF2, type: "Numeric" },
          {
            name: BULK_C,
            type: "Consolidated",
            components: [
              { name: LEAF1, weight: 1 },
              { name: LEAF2, weight: -1 },
            ],
          },
        ],
      });

      expect(await edgeWeight(BULK_C, LEAF2)).toBe(-1);
      // The 1s are left alone on purpose — no request is spent on them.
      expect(await edgeWeight(BULK_C, LEAF1)).toBe(1);
    });

    it("the naming audit finds a violating element name on this server", async () => {
      // The audit no longer downloads element names: it asks TM1 for the ones
      // that MIGHT violate a rule and checks only those. That is only safe if
      // the server's evaluation agrees with ours, which no unit test can
      // establish — a mock agreeing with itself proves nothing.
      //
      // QUOTE_EL contains an apostrophe, a TM1-Server-reserved character, and
      // is also the literal OData is likeliest to misparse (the quote has to
      // be doubled inside the filter). If the push-down were unsound, this
      // element would be missing from the findings and the audit would report
      // a clean model — the exact failure this test exists to prevent.
      const r = await h.ok("tm1_audit_naming", {
        scope: ["elements"],
        maxFindings: 500,
      });
      const findings = (
        r.json as {
          findings?: Array<{
            objectName: string;
            violations: Array<{ rule: string }>;
          }>;
        }
      ).findings;
      const hit = findings?.find((f) => f.objectName === QUOTE_EL);
      expect(
        hit,
        `expected ${QUOTE_EL} among the naming findings`,
      ).toBeDefined();
      expect(hit!.violations.map((v) => v.rule)).toContain(
        "server_reserved_char",
      );
    });

    it("bulk-upserts more elements (leafs before consolidation)", async () => {
      const r = await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM,
        hierarchyName: HIER,
        elements: [
          { name: LEAF2, type: "Numeric" },
          { name: LEAF3, type: "Numeric" },
          {
            name: TOP,
            type: "Consolidated",
            components: [{ name: SUB, weight: 1 }],
          },
        ],
      });
      expect(r.json).toMatchObject({ success: true, total: 3 });
    });

    it("bulk-upsert is idempotent and surfaces in-place type changes", async () => {
      // Create a standalone leaf.
      const a = await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM,
        hierarchyName: HIER,
        elements: [{ name: TC, type: "Numeric" }],
      });
      expect(a.json).toMatchObject({ success: true });
      expect(a.json.typeChanges ?? []).toEqual([]);

      // Re-upsert with the SAME type must be idempotent. Regression: TM1 v11
      // reports "element already exists" as HTTP 400 (not 409), which used to
      // escape the conflict handler and throw.
      const b = await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM,
        hierarchyName: HIER,
        elements: [{ name: TC, type: "Numeric" }],
      });
      expect(b.json).toMatchObject({ success: true });
      expect(b.json.typeChanges ?? []).toEqual([]);

      // Changing the type in place must be reported (it discards leaf data).
      const c = await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: DIM,
        hierarchyName: HIER,
        elements: [{ name: TC, type: "String" }],
      });
      expect(c.json.typeChanges).toEqual([
        { name: TC, from: "Numeric", to: "String" },
      ]);
      expect(typeof c.json.warning).toBe("string");
    });

    it("reads the created elements back, the quoted one by its key", async () => {
      const all = await names(h, `${HIER_PATH}/Elements`);
      expect(all).toEqual(expect.arrayContaining([LEAF1, QUOTE_EL, SUB, TOP]));
      const quoted = await restGet<{ Name: string }>(
        h,
        `${HIER_PATH}/${seg("Elements", QUOTE_EL)}?$select=Name`,
      );
      expect(quoted.Name).toBe(QUOTE_EL);
    });

    it("creates an alternate hierarchy", async () => {
      await restWrite(h, "POST", `${seg("Dimensions", DIM)}/Hierarchies`, {
        Name: ALT_HIER,
      });
      expect(await names(h, `${seg("Dimensions", DIM)}/Hierarchies`)).toContain(
        ALT_HIER,
      );
    });

    it("resolves default members via the bulk tool, one item and several", async () => {
      const single = await h.ok("tm1_resolve_default_members", {
        items: [{ dimensionName: DIM }],
      });
      expect(single.json.results.length).toBe(1);
      expect(single.json.results[0]).toHaveProperty("source");
      expect(single.json.results[0]).toHaveProperty("confidence");

      const r = await h.ok("tm1_resolve_default_members", {
        items: [
          { dimensionName: DIM },
          { dimensionName: DIM, hierarchyName: ALT_HIER },
        ],
      });
      expect(Array.isArray(r.json.results)).toBe(true);
      expect(r.json.results.length).toBe(2);
    });

    it("creates string + numeric attributes and lists them", async () => {
      await restWrite(h, "POST", `${HIER_PATH}/ElementAttributes`, {
        Name: "Caption",
        Type: "String",
      });
      await restWrite(h, "POST", `${HIER_PATH}/ElementAttributes`, {
        Name: "SortOrder",
        Type: "Numeric",
      });
      const attrs = await names(h, `${HIER_PATH}/ElementAttributes`);
      expect(attrs).toContain("Caption");
      expect(attrs).toContain("SortOrder");
    });

    it("sets and reads back attribute values", async () => {
      await h.ok("tm1_update_element_attribute_value", {
        dimensionName: DIM,
        elementName: LEAF1,
        attributeName: "Caption",
        value: "North City A",
      });
      await h.ok("tm1_update_element_attribute_value", {
        dimensionName: DIM,
        elementName: LEAF1,
        attributeName: "SortOrder",
        value: 42,
      });
      const el = await restGet<{ Attributes: Record<string, unknown> }>(
        h,
        `${HIER_PATH}/${seg("Elements", LEAF1)}?$select=Name,Attributes`,
      );
      expect(String(el.Attributes.Caption)).toBe("North City A");
      expect(Number(el.Attributes.SortOrder)).toBe(42);
    });

    it("reads element types from a real hierarchy", async () => {
      // Narrow Name,Type read. The list is every dimension but control ones,
      // so the first that answers with elements is the one checked.
      const dims = (
        await restGet<Array<{ Name: string }>>(
          h,
          "Dimensions?$select=Name&$filter=not startswith(Name,'}')&$top=25",
        )
      ).map((d) => d.Name);
      let checked = 0;
      for (const dim of dims) {
        let elements;
        try {
          elements = await h.client.hierarchies.getElementTypes(dim, dim);
        } catch {
          continue; // alternate hierarchy naming or no read rights — try next
        }
        if (elements.length === 0) continue;
        for (const e of elements.slice(0, 50)) {
          expect(typeof e.name).toBe("string");
          expect(["Numeric", "Consolidated", "String"]).toContain(e.type);
        }
        checked++;
        break;
      }
      // A bare v12 database has no user dimensions; then this has nothing to type.
      if (dims.length > 0) expect(checked).toBe(1);
    });

    it("deletes the quoted element", async () => {
      await restWrite(h, "DELETE", `${HIER_PATH}/${seg("Elements", QUOTE_EL)}`);
      expect(await names(h, `${HIER_PATH}/Elements`)).not.toContain(QUOTE_EL);
    });

    it("deletes the alternate hierarchy", async () => {
      await restWrite(
        h,
        "DELETE",
        `${seg("Dimensions", DIM)}/${seg("Hierarchies", ALT_HIER)}`,
      );
      expect(
        await names(h, `${seg("Dimensions", DIM)}/Hierarchies`),
      ).not.toContain(ALT_HIER);
    });

    it("deletes the dimension (cascade)", async () => {
      await restWrite(h, "DELETE", seg("Dimensions", DIM));
      expect(await names(h, "Dimensions", DIM)).not.toContain(DIM);
    });
  },
);

// Element batches: attribute coercion and bulk removal guards, and the
// delete_elements report for a batch that names a missing element.
describe.skipIf(!LIVE_ENABLED)("live: element batches", () => {
  let h: LiveHarness;
  const BATCH = `${SANDBOX}_BATCH_DIM`;
  const BATCH_HIER = `${seg("Dimensions", BATCH)}/${seg("Hierarchies", BATCH)}`;
  const REMOVE = `${SANDBOX}_BATCH_REMOVE`;
  const LEAVES = Array.from(
    { length: 12 },
    (_, i) => `L${String(i).padStart(2, "0")}`,
  );

  const elementCount = async () => {
    const r = await h.ok("tm1_rest_read", {
      path: `${BATCH_HIER}/Elements/$count`,
    });
    return Number(r.json.text ?? r.json.data);
  };

  const cleanup = async () => {
    await dropIfExists(h, seg("Dimensions", BATCH));
    await dropIfExists(h, seg("Dimensions", REMOVE));
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, BATCH);
    await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: BATCH,
      elements: [
        ...LEAVES.map((name) => ({ name, type: "Numeric" })),
        {
          name: "Total",
          type: "Consolidated",
          components: LEAVES.map((name) => ({ name, weight: 1 })),
        },
      ],
    });
  });

  afterAll(cleanup);

  it("writes attribute values in one batch, coerced to the attribute type", async () => {
    await restWrite(h, "POST", `${BATCH_HIER}/ElementAttributes`, {
      Name: "Weight",
      Type: "Numeric",
    });
    await restWrite(h, "POST", `${BATCH_HIER}/ElementAttributes`, {
      Name: "Caption",
      Type: "String",
    });
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: BATCH,
      updates: [
        { elementName: "L00", attributeName: "Weight", value: "12.5" },
        { elementName: "L01", attributeName: "Weight", value: 3 },
        { elementName: "L00", attributeName: "Caption", value: "zero" },
      ],
    });
    const bad = await h.call("tm1_update_element_attribute_value", {
      dimensionName: BATCH,
      elementName: "L02",
      attributeName: "Weight",
      value: "heavy",
    });
    expect(bad.isError).toBe(true);
    expect(bad.json.code).toBe("VALIDATION_ERROR");

    const l00 = await restGet<{ Attributes: Record<string, unknown> }>(
      h,
      `${BATCH_HIER}/Elements('L00')?$select=Name,Attributes`,
    );
    expect(l00.Attributes).toMatchObject({ Weight: 12.5, Caption: "zero" });
  });

  it("bulk_upsert refuses to drop children without confirm; dryRun shows it", async () => {
    await createDimension(h, REMOVE, [
      "A",
      "B",
      { name: "Total", children: ["A", "B"] },
    ]);
    const onlyA = {
      dimensionName: REMOVE,
      elements: [
        { name: "Total", type: "Consolidated", components: [{ name: "A" }] },
      ],
    };
    const dry = await h.ok("tm1_bulk_upsert_elements", {
      ...onlyA,
      dryRun: true,
    });
    expect(dry.json).toMatchObject({
      dryRun: true,
      creates: [],
      updates: ["Total"],
      removals: [{ parent: "Total", children: ["B"] }],
    });
    const refused = await h.call("tm1_bulk_upsert_elements", onlyA);
    expect(refused.isError).toBe(true);
    expect(refused.json.message).toContain("would remove 1 existing child");
    const still = await names(
      h,
      `${seg("Dimensions", REMOVE)}/${seg("Hierarchies", REMOVE)}/Elements('Total')/Components`,
    );
    expect(still).toContain("B");

    await h.ok("tm1_bulk_upsert_elements", { ...onlyA, confirm: REMOVE });
    const after = await h.ok("tm1_bulk_upsert_elements", {
      ...onlyA,
      dryRun: true,
    });
    expect(after.json.removals).toEqual([]);
  });

  it("delete_elements removes many and reports the missing one", async () => {
    // Detach the leaves first so the consolidation does not hold them.
    await restWrite(h, "DELETE", `${BATCH_HIER}/Elements('Total')`);
    const r = await h.ok("tm1_delete_elements", {
      dimensionName: BATCH,
      elementNames: ["L10", "L11", "NOPE"],
      confirm: BATCH,
    });
    expect(r.json).toMatchObject({
      success: false,
      deleted: 2,
      failed: 1,
      failures: [{ elementName: "NOPE" }],
    });
    expect(await elementCount()).toBe(10);
  });
});

// Element search: the MDX FILTER the tool runs on the server, the exact total
// next to a capped list, and the cube-wide scope.
describe.skipIf(!LIVE_ENABLED)("live: tm1_search_elements", () => {
  let h: LiveHarness;
  const SEARCH = `${SANDBOX}_SE_DIM`;
  const OTHER = `${SANDBOX}_SE_OTHER`;
  const CUBE = `${SANDBOX}_SE_CUBE`;

  const cleanup = async () => {
    await dropIfExists(h, seg("Cubes", CUBE));
    await dropIfExists(h, seg("Dimensions", SEARCH));
    await dropIfExists(h, seg("Dimensions", OTHER));
  };

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, SEARCH, [
      "Harbor_North",
      "HARBOR_South",
      "Inland",
    ]);
    await createDimension(h, OTHER, ["Harbor_Total", "Rest"]);
    await createCube(h, CUBE, [SEARCH, OTHER]);
  });

  afterAll(cleanup);

  it("matches names case-insensitively and counts past topN", async () => {
    const r = await h.ok("tm1_search_elements", {
      searchTerm: "harbor",
      dimensionName: SEARCH,
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
    expect(found.sort()).toEqual([SEARCH, OTHER].sort());
    const none = await h.ok("tm1_search_elements", {
      searchTerm: "no_such_term_zz",
      cubeName: CUBE,
    });
    expect(none.json.dimensions).toEqual([]);
  });
});
