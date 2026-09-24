import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import {
  fetchCubeStats,
  CubeStatsUnavailableError,
  type CubeStatsItem,
  type StatsUnavailableReason,
} from "../../lib/cube-stats/fetcher.js";
import { CubeStatsResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetCubeStats = defineTool({
  name: "tm1_get_cube_stats",
  description: [
    "Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency).",
    "Well-known metrics are mapped to typed fields; the full element-name → value map is also returned under `raw` so server-side renames don't break the tool.",
    "Per-cube errors are reported as items[].error without failing the whole call.",
    "Servers with no }Stats* control cubes (TM1 v12), or accounts not allowed to read them, return `statsUnavailable` {reason: absent|denied} instead of a raw error.",
  ],
  annotations: READ_ONLY,
  output: CubeStatsResultSchema,
  input: {
    cubeName: z
      .string()
      .optional()
      .describe("Single cube name. Mutually exclusive with cubeNames."),
    cubeNames: z
      .array(z.string())
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Batch mode — list of cube names (max 500). Mutually exclusive with cubeName.",
      ),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ cubeName, cubeNames, format }, tm1Client) => {
    if (cubeName !== undefined && cubeNames !== undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "cubeName and cubeNames are mutually exclusive — pass only one.",
      });
    }
    const targets = cubeNames ?? (cubeName !== undefined ? [cubeName] : []);
    if (targets.length === 0) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Specify exactly one of cubeName or cubeNames.",
      });
    }

    // One }StatsByCube MDX per target, capped in flight. Unbounded, a batch
    // of a few hundred cubes hands TM1's worker pool that many simultaneous
    // queries — the same reason tm1_audit_feeders caps its runtime pass at
    // the same width.
    const settled = await mapSettledWithConcurrency(targets, 10, (name) =>
      fetchCubeStats(tm1Client, name),
    );
    const items: CubeStatsItem[] = settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const err: unknown = r.reason;
      // `}StatsByCube` missing or unreadable is a property of the server or
      // the account, not of this cube — its message is already plain prose.
      if (err instanceof CubeStatsUnavailableError)
        return { cubeName: targets[i]!, raw: {}, error: err.message };
      const msg =
        err instanceof TM1Error ? `${err.code}: ${err.message}` : String(err);
      return { cubeName: targets[i]!, raw: {}, error: msg };
    });

    // Success envelope, not isError: "this server does not keep these
    // statistics" is an answer, and the tool already reports per-cube
    // failures inside a successful payload. The top-level annotation is set
    // only when EVERY target failed for the same server-wide reason, so a
    // one-off per-cube failure never gets generalised into a claim about
    // the server.
    const statsUnavailable = serverWideUnavailability(settled);
    const payload = {
      count: items.length,
      items,
      ...(statsUnavailable ? { statsUnavailable } : {}),
    };
    const columns = columnsOf<CubeStatsItem>([
      { header: "cube", get: (i) => i.cubeName },
      "memoryTotal",
      "populatedNumeric",
      "fedCells",
      "feederEfficiency",
      "error",
    ]);
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Cube stats\n\n${p.count} cubes\n\n` +
        (statsUnavailable ? `> ${statsUnavailable.message}\n\n` : "") +
        renderTable(p.items, columns),
    );
  },
});

interface StatsUnavailable {
  reason: StatsUnavailableReason;
  message: string;
}

/**
 * Collapse per-cube failures into one server-wide verdict — but only when
 * every requested cube failed the same way. A mixed result stays per-cube.
 */
function serverWideUnavailability(
  settled: PromiseSettledResult<CubeStatsItem>[],
): StatsUnavailable | undefined {
  if (settled.length === 0) return undefined;
  let first: CubeStatsUnavailableError | undefined;
  for (const r of settled) {
    if (r.status !== "rejected") return undefined;
    const err: unknown = r.reason;
    if (!(err instanceof CubeStatsUnavailableError)) return undefined;
    first ??= err;
    if (err.reason !== first.reason) return undefined;
  }
  return first ? { reason: first.reason, message: first.message } : undefined;
}
