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
  sharedUnavailability,
  type CubeStatsItem,
} from "../../lib/cube-stats/fetcher.js";
import { storageMatchesDisplayOrder } from "../../lib/cube-stats/dimension-order-helper.js";
import { CubeStatsResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetCubeStats = defineTool({
  name: "tm1_get_cube_stats",
  description: [
    "Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency).",
    "Well-known metrics are mapped to typed fields; the full element-name → value map is also returned under `raw` so server-side renames don't break the tool.",
    "Per-cube errors are reported as items[].error without failing the whole call.",
    "}Stats* cubes are absent on v12, and on v11 unless statistics collection is on. Then, or when the account may not read them, return `statsUnavailable` {reason: absent|denied} instead of a raw error.",
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
    includeDimensionOrder: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Also fetch each cube's displayOrder vs storageOrder (Cubes/tm1.DimensionsStorageOrder()) — works on both v11 and v12 even when }StatsByCube is absent.",
      ),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { cubeName, cubeNames, includeDimensionOrder, format },
    tm1Client,
  ) => {
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

    const fetchOrderFor = async (
      name: string,
    ): Promise<{
      displayOrder?: string[];
      storageOrder?: string[];
      storageMatchesDisplay?: boolean;
      dimensionOrderError?: string;
    }> => {
      if (!includeDimensionOrder) return {};
      try {
        const [displayOrder, storageOrder] = await Promise.all([
          tm1Client.cubes.getDimensionNames(name),
          tm1Client.cubes.getDimensionsStorageOrder(name),
        ]);
        return {
          displayOrder,
          storageOrder,
          storageMatchesDisplay: storageMatchesDisplayOrder(
            displayOrder,
            storageOrder,
          ),
        };
      } catch (err) {
        return {
          dimensionOrderError:
            err instanceof TM1Error
              ? `${err.code}: ${err.message}`
              : String(err),
        };
      }
    };

    // One }StatsByCube MDX per target, capped in flight. Unbounded, a batch
    // of a few hundred cubes hands TM1's worker pool that many simultaneous
    // queries — the same reason tm1_audit_feeders caps its runtime pass at
    // the same width.
    const settledWithOrder = await mapSettledWithConcurrency(
      targets,
      10,
      async (name) => {
        const [statsRes, orderExtras] = await Promise.all([
          fetchCubeStats(tm1Client, name).then(
            (value): PromiseSettledResult<CubeStatsItem> => ({
              status: "fulfilled",
              value,
            }),
            (reason: unknown): PromiseSettledResult<CubeStatsItem> => ({
              status: "rejected",
              reason,
            }),
          ),
          fetchOrderFor(name),
        ]);
        return { statsRes, orderExtras };
      },
    );

    const settled: PromiseSettledResult<CubeStatsItem>[] = settledWithOrder.map(
      (r) =>
        r.status === "fulfilled"
          ? r.value.statsRes
          : { status: "rejected", reason: r.reason as unknown },
    );

    const items: CubeStatsItem[] = settledWithOrder.map((r, i) => {
      const orderExtras = r.status === "fulfilled" ? r.value.orderExtras : {};
      const statsRes: PromiseSettledResult<CubeStatsItem> =
        r.status === "fulfilled"
          ? r.value.statsRes
          : { status: "rejected", reason: r.reason as unknown };
      if (statsRes.status === "fulfilled") {
        return { ...statsRes.value, ...orderExtras };
      }
      const err: unknown = statsRes.reason;
      // `}StatsByCube` missing or unreadable is a property of the server or
      // the account, not of this cube — its message is already plain prose.
      if (err instanceof CubeStatsUnavailableError) {
        return {
          cubeName: targets[i]!,
          raw: {},
          error: err.message,
          ...orderExtras,
        };
      }
      const msg =
        err instanceof TM1Error ? `${err.code}: ${err.message}` : String(err);
      return { cubeName: targets[i]!, raw: {}, error: msg, ...orderExtras };
    });

    // Success envelope, not isError: "this server does not keep these
    // statistics" is an answer, and the tool already reports per-cube
    // failures inside a successful payload. The top-level annotation is set
    // only when EVERY target failed for the same server-wide reason, so a
    // one-off per-cube failure never gets generalised into a claim about
    // the server.
    const shared = sharedUnavailability(settled);
    const statsUnavailable = shared
      ? { reason: shared.reason, message: shared.message }
      : undefined;
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
      ...(includeDimensionOrder ? (["storageMatchesDisplay"] as const) : []),
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
