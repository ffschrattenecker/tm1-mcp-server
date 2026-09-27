// Per-connection cache of each cube's dimension order.
//
// Every single-cell read, trace and write resolves the cube's dimension order
// first — one GET before the real request. A cube's dimensions are fixed at
// creation (TM1 has no "add a dimension" — only delete and recreate), so the
// answer is stable and worth caching. TM1py leaves this to the caller
// (`dimensions=` "speeds things up"); an MCP server cannot, so it caches here.
//
// Staleness guards:
//   - any mutation on THIS connection clears the cache, except the cell
//     read/write hot path (ExecuteMDX + Cellsets), which cannot recreate a
//     cube. Unrecognised mutations — TI runs, chores, $batch — clear it, so a
//     process that rebuilds a cube is stale-safe by default.
//   - a TTL covers changes made by other clients of the same server.
import type { TM1HttpClient } from "../http.js";
import { tm1NameKey } from "../../lib/tm1-name.js";
import { odataKey as enc } from "./odata-page.js";

const TTL_MS = 60_000;
const INERT_PATHS = [/\/ExecuteMDX/i, /\/Cellsets/i];

export class DimensionOrderCache {
  private readonly entries = new Map<
    string,
    { dims: Promise<string[]>; at: number }
  >();

  constructor(
    private readonly http: TM1HttpClient,
    private readonly now: () => number = Date.now,
  ) {
    // Test doubles stub only request(); a real client always has the hook.
    if (typeof http.onMutation === "function") {
      http.onMutation((e) => {
        if (!INERT_PATHS.some((re) => re.test(e.path))) this.entries.clear();
      });
    }
  }

  /**
   * Ordered dimension names of `cubeName`.
   * GET /api/v1/Cubes('{name}')?$expand=Dimensions($select=Name)
   */
  get(cubeName: string): Promise<string[]> {
    const key = tm1NameKey(cubeName);
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.dims;

    // The promise is cached, so concurrent callers share one request; a
    // failure is evicted so the next call retries instead of replaying it.
    const dims = this.http
      .request<{
        Dimensions: Array<{ Name: string }>;
      }>(
        "GET",
        `/api/v1/Cubes('${enc(cubeName)}')?$expand=Dimensions($select=Name)`,
      )
      .then((r) => r.Dimensions.map((d) => d.Name));
    this.entries.set(key, { dims, at: this.now() });
    dims.catch(() => {
      if (this.entries.get(key)?.dims === dims) this.entries.delete(key);
    });
    return dims;
  }
}
