// Broad read-only sweep over a real model.
//
// The rest of the live suite works almost entirely on objects it creates
// itself under the sandbox prefix. Those objects are deliberately minimal — a
// two-element dimension, an empty cube, a process with no data source — so
// whole branches of the response shapes never appear: cells are always null,
// a view's MDX is never populated, a process never carries an ODBC data
// source, an element never has children.
//
// That thinness is invisible in normal test runs and load-bearing for the wire
// contracts, which are recorded from live traffic: a contract that only ever
// saw `Value: null` will later reject a perfectly valid fake that uses
// numbers. This file walks the model that is actually on the server —
// whatever it is — and reads it, so the recording sees populated shapes.
//
// Strictly read-only: safe to point at any server, including production.
// Every call is discovery-driven; nothing is created, changed, or deleted.
import { describe, it, expect, beforeAll } from "vitest";
import {
  getHarness,
  LIVE_ENABLED,
  restGet,
  seg,
  type LiveHarness,
} from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: broad read sweep", () => {
  let h: LiveHarness;
  let cube: string | undefined;
  let dimension: string | undefined;
  let process: string | undefined;

  beforeAll(async () => {
    h = await getHarness();
    const first = async (coll: string) =>
      (
        await restGet<Array<{ Name: string }>>(
          h,
          `${coll}?$select=Name&$filter=not startswith(Name,'}')&$top=1`,
        )
      )[0]?.Name;
    cube = await first("Cubes");
    dimension = await first("Dimensions");
    process = await first("Processes");
  });

  it("reads the ADMIN group with its members", async () => {
    // Every server has the admin group, and someone is in it.
    const admin = await restGet<{ Users: Array<{ Name: string }> }>(
      h,
      "Groups('ADMIN')?$select=Name&$expand=Users($select=Name)",
    );
    expect(admin.Users.length).toBeGreaterThan(0);
  });

  it("finds something to read", () => {
    // Not an assertion about any particular model — only that the server has
    // enough content for the rest of this file to mean anything.
    expect([cube, dimension, process].some(Boolean)).toBe(true);
  });

  it("reads a cube's views, definitions and rules", async () => {
    if (!cube) return;
    const first = (
      await restGet<Array<{ Name: string }>>(
        h,
        `${seg("Cubes", cube)}/Views?$select=Name&$top=5`,
      )
    )[0]?.Name;
    if (first) {
      await restGet(h, `${seg("Cubes", cube)}/${seg("Views", first)}`);
      // Real cells: the sandbox cube is empty, so this is the only place a
      // populated Value/FormattedValue shape is ever observed.
      await h.call("tm1_get_view", {
        cubeName: cube,
        viewName: first,
        limit: 20,
      });
    }
    await h.call("tm1_get_cube_rules", { cubeName: cube });
    await h.call("tm1_get_cube_stats", { cubeName: cube });
  });

  it("reads a dimension's hierarchy, elements, subsets and attributes", async () => {
    if (!dimension) return;
    // TM1's default hierarchy carries the dimension's own name.
    const hierarchyName = dimension;
    const hier = `${seg("Dimensions", dimension)}/${seg("Hierarchies", hierarchyName)}`;
    await restGet(h, `${hier}/Subsets?$select=Name&$top=5`);
    await restGet(h, `${hier}/ElementAttributes`);
    const els = await restGet<Array<{ Name: string }>>(
      h,
      `${hier}/Elements?$select=Name,Type,Level&$expand=Parents($select=Name),Components($select=Name)&$top=50`,
    );
    const el = els[0]?.Name;
    if (el) {
      // Consolidated elements are where Children/Parents actually appear.
      await restGet(
        h,
        `${hier}/${seg("Elements", el)}?$expand=Parents,Components`,
      );
      await h.call("tm1_resolve_default_members", {
        items: [{ dimensionName: dimension }],
      });
    }
  });

  it("reads a process with its real data source, parameters and variables", async () => {
    if (!process) return;
    // A real process is the only source of a populated DataSource shape —
    // ODBC/ASCII fields that a sandbox process never has.
    await h.ok("tm1_get_process", { processName: process });
    await h.call("tm1_get_process", { processName: process });
  });

  it("runs the whole-model read audits", async () => {
    // These are the tools that fan out across the entire model, so they are
    // where a per-item round trip hides. Running them here keeps their real
    // query shapes in the recorded contracts — audit_complexity now reads
    // every process's Variables from the process list itself, and that only
    // shows up in a recording if something exercises it.
    await h.call("tm1_audit_complexity", { limit: 10 });
    await h.call("tm1_audit_naming", { limit: 10 });
  });

  it("reads server-level collections", async () => {
    await h.call("tm1_get_server_state");
    await restGet(h, "Chores?$select=Name&$expand=Tasks&$top=5");
    await restGet(h, "Users?$select=Name&$expand=Groups($select=Name)&$top=5");
    await restGet(h, "Groups?$select=Name&$top=5");
    await restGet(h, "Sessions?$select=ID&$expand=User($select=Name)&$top=5");
    await h.call("tm1_list_error_logs", { limit: 5 });
    await h.call("tm1_files_read", { op: "list" });
  });
});
