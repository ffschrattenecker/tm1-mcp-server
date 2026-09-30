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
const NONEXISTENT = `${SANDBOX}_DIM_DOES_NOT_EXIST`;

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

    it("resolves a single default member via the bulk tool (1-item array)", async () => {
      const r = await h.ok("tm1_resolve_default_members", {
        items: [{ dimensionName: DIM }],
      });
      expect(r.json.results.length).toBe(1);
      expect(r.json.results[0]).toHaveProperty("source");
      expect(r.json.results[0]).toHaveProperty("confidence");
    });

    it("bulk-resolves default members", async () => {
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

    // ── Negative path ──────────────────────────────────────────────────────
    it("reading a nonexistent dimension errors with a code", async () => {
      const r = await h.call("tm1_rest_read", {
        path: `${seg("Dimensions", NONEXISTENT)}/${seg("Hierarchies", NONEXISTENT)}`,
      });
      expect(r.isError).toBe(true);
      expect(r.json?.code).toBeTruthy();
    });

    it("deletes the dimension (cascade)", async () => {
      await restWrite(h, "DELETE", seg("Dimensions", DIM));
      expect(await names(h, "Dimensions", DIM)).not.toContain(DIM);
    });
  },
);
