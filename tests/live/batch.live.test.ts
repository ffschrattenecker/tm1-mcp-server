// Live $batch checks: the counter-probe for an ambiguous 400, and bulk upserts
// that cross the chunk limits. The unit suites prove the logic against mocks;
// these prove the same paths behave against a real TM1 server.
//
// The counter-probe in particular CANNOT be reached through the tool layer: it
// only fires on an HTTP 400 from the FIRST $batch envelope on a connection, so
// it needs direct BatchService access and must run before any successful batch.
// That is why the probe block is first in this file, and why the file is meant
// to be run on its own:
//
//   npx vitest run --config vitest.live.config.ts tests/live/batch.live.test.ts
//
// Run inside the whole live suite it still passes, but the probe assertions
// self-skip because another file will have marked the connection supported.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";
import { BatchUnsupportedError } from "../../src/tm1-client/services/batch-service.js";

const PROBE_DIM = `${SANDBOX}_BATCH_CHUNK_DIM`;

describe.skipIf(!LIVE_ENABLED)("live: $batch", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
  });

  afterAll(async () => {
    await dropIfExists(h, seg("Dimensions", PROBE_DIM));
  });

  // ---- $batch counter-probe: must run FIRST (needs an undecided tri-state) --
  describe("$batch counter-probe on an ambiguous 400", () => {
    it("does not mistake a payload-400 for a missing endpoint", async () => {
      if (h.client.batch.isKnownUnsupported) {
        console.log(
          "[probe] connection already marked unsupported — nothing to prove",
        );
        return;
      }

      // Duplicate correlation ids. The envelope is well-formed JSON but invalid
      // per the OData batch spec, so a server that HAS $batch rejects the whole
      // envelope with 400 — exactly the shape that used to be misread as
      // "this server has no $batch".
      let thrown: unknown;
      try {
        await h.client.batch.execute([
          { id: "dup", method: "GET", path: "/api/v1/Configuration" },
          { id: "dup", method: "GET", path: "/api/v1/Configuration" },
        ]);
      } catch (err) {
        thrown = err;
      }

      if (thrown === undefined) {
        // Server tolerated duplicate ids. Then this server cannot produce the
        // ambiguous case at all — report it rather than assert a false pass.
        console.log(
          "[probe] server accepted duplicate sub-request ids; no envelope-level 400 available here",
        );
        expect(h.client.batch.isKnownUnsupported).toBe(false);
        return;
      }

      console.log(
        `[probe] envelope rejected with: ${(thrown as Error).name}: ${(thrown as Error).message}`,
      );

      // The point of the fix: whatever went wrong, it must not have been
      // recorded as "no $batch on this server".
      expect(thrown).not.toBeInstanceOf(BatchUnsupportedError);
      expect(h.client.batch.isKnownUnsupported).toBe(false);
    });

    it("still serves a well-formed batch after the rejected one", async () => {
      if (h.client.batch.isKnownUnsupported) {
        console.log("[probe] connection unsupported — skipping");
        return;
      }
      const results = await h.client.batch.execute([
        {
          id: "r1",
          method: "GET",
          path: "/api/v1/Configuration/ProductVersion",
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("r1");
      console.log(
        `[probe] probe-path sub-status: ${results[0].status}, ok=${results[0].ok}`,
      );
      // The probe judges the ENVELOPE, not this status — a locked-down account
      // may legitimately be refused the read. Both outcomes prove $batch works.
      expect(typeof results[0].status).toBe("number");
    });
  });

  // ---- byte-capped chunking still upserts correctly ------------------------
  describe("byte-capped $batch chunking", () => {
    it("bulk-upserts across chunk boundaries without loss", async () => {
      await dropIfExists(h, seg("Dimensions", PROBE_DIM));
      await createDimension(h, PROBE_DIM, ["Seed"]);

      // Long names inflate per-sub-request bytes; 250 elements also crosses the
      // 200-request count cap, so both bounds are exercised in one call.
      const pad = "N".repeat(180);
      const elements = Array.from({ length: 250 }, (_, i) => ({
        name: `E${String(i).padStart(4, "0")}_${pad}`,
        type: "Numeric" as const,
      }));

      const up = await h.ok("tm1_bulk_upsert_elements", {
        dimensionName: PROBE_DIM,
        elements,
      });
      expect(up.isError).toBe(false);

      const typed = await h.client.hierarchies.getElementTypes(
        PROBE_DIM,
        PROBE_DIM,
      );
      const created = typed.filter((e) => e.name.startsWith("E")).length;
      console.log(`[chunking] upserted 250, found ${created} back`);
      expect(created).toBe(250);
    });
  });
});
