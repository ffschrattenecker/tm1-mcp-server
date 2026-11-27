import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { fetchCubeStats } from "../../lib/cube-stats/fetcher.js";
import {
  storageMatchesDisplayOrder,
  validateStorageDimensionOrder,
} from "../../lib/cube-stats/dimension-order-helper.js";
import { tm1NameEquals } from "../../lib/tm1-name.js";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { extraSignal } from "../context.js";

const REORDER_NOTE =
  "Optimal TM1 storage order is generally smallest-sparse -> largest-sparse -> largest-dense -> smallest-dense; verify density and memory impact via tm1_get_cube_stats / percentMemoryChange.";

export const registerReorderCubeDimensions = defineTool({
  name: "tm1_reorder_cube_dimensions",
  description: [
    "Inspect or reorder a cube's internal storage dimensions (tm1.DimensionsStorageOrder / tm1.ReorderDimensions).",
    "Default dryRun=true inspects current storage vs display order, element counts, and validates any proposed dimensionOrder without locking the cube.",
    "Set dryRun=false with dimensionOrder to apply the reorder and report percentMemoryChange (and before/after }StatsByCube memory when available).",
  ],
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().min(1).describe("Name of the TM1 cube."),
    dimensionOrder: z
      .array(z.string().min(1))
      .min(2)
      .optional()
      .describe(
        "Proposed storage dimension order (exact set of cube storage dimensions, excluding Sandboxes). Omit with dryRun=true to inspect current order, dimension sizes, and heuristic suggestion.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Default true: inspect/validate order and dimension sizes without applying. Set dryRun=false with dimensionOrder to run tm1.ReorderDimensions.",
      ),
    measureMemory: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Read }StatsByCube memoryTotal before/after (best-effort; skipped gracefully when }StatsByCube is unavailable on v12).",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override default 30s timeout (ms) for reordering large cubes.",
      ),
  },
  handler: async (
    { cubeName, dimensionOrder, dryRun, measureMemory, timeoutMs },
    tm1Client,
    extra,
  ) => {
    const [displayOrder, currentStorageOrder, beforeStats] = await Promise.all([
      tm1Client.cubes.getDimensionNames(cubeName),
      tm1Client.cubes.getDimensionsStorageOrder(cubeName),
      measureMemory
        ? fetchCubeStats(tm1Client, cubeName).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const matchesDisplay = storageMatchesDisplayOrder(
      displayOrder,
      currentStorageOrder,
    );

    if (dryRun) {
      const dims = await tm1Client.dimensions
        .list({ includeElementCount: true })
        .catch(() => []);
      const dimensionSizes = currentStorageOrder.map((dimName) => {
        const match = dims.find((d) => tm1NameEquals(d.name, dimName));
        const count =
          match?.elementCounts?.[dimName] ??
          match?.elementCounts?.[match.name] ??
          null;
        return { dimension: dimName, elementCount: count };
      });
      const suggestedBySize = [...dimensionSizes]
        .sort((a, b) => {
          if (a.elementCount === null && b.elementCount === null) return 0;
          if (a.elementCount === null) return 1;
          if (b.elementCount === null) return -1;
          return a.elementCount - b.elementCount;
        })
        .map((d) => d.dimension);

      const validated = dimensionOrder
        ? validateStorageDimensionOrder(currentStorageOrder, dimensionOrder)
        : undefined;

      return actionResponse({
        success: true,
        dryRun: true,
        cubeName,
        displayOrder,
        currentStorageOrder,
        storageMatchesDisplay: matchesDisplay,
        ...(validated
          ? {
              proposedOrder: validated.canonical,
              wouldChange: validated.changed,
            }
          : {}),
        dimensionSizes,
        suggestedBySize,
        ...(beforeStats?.memoryTotal !== undefined
          ? { beforeMemoryTotal: beforeStats.memoryTotal }
          : {}),
        note: REORDER_NOTE,
      });
    }

    if (!dimensionOrder) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "dimensionOrder is required when dryRun=false.",
        hint: "Run with dryRun=true first to inspect currentStorageOrder and dimensionSizes, then pass dimensionOrder with dryRun=false.",
      });
    }

    const { canonical, changed } = validateStorageDimensionOrder(
      currentStorageOrder,
      dimensionOrder,
    );

    if (!changed) {
      return actionResponse({
        success: true,
        dryRun: false,
        cubeName,
        changed: false,
        storageOrder: currentStorageOrder,
        percentMemoryChange: 0,
        message:
          "Cube storage order already matches requested dimensionOrder; no reorder was executed.",
      });
    }

    const percentMemoryChange = await tm1Client.cubes.reorderDimensions(
      cubeName,
      canonical,
      {
        signal: extraSignal(extra),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    );

    const [afterStorageOrder, afterStats] = await Promise.all([
      tm1Client.cubes.getDimensionsStorageOrder(cubeName),
      measureMemory && beforeStats
        ? fetchCubeStats(tm1Client, cubeName).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const beforeMem =
      typeof beforeStats?.memoryTotal === "number"
        ? beforeStats.memoryTotal
        : undefined;
    const afterMem =
      typeof afterStats?.memoryTotal === "number"
        ? afterStats.memoryTotal
        : undefined;
    const memoryDeltaBytes =
      beforeMem !== undefined && afterMem !== undefined
        ? afterMem - beforeMem
        : undefined;

    return actionResponse({
      success: true,
      dryRun: false,
      cubeName,
      changed: true,
      previousStorageOrder: currentStorageOrder,
      storageOrder: afterStorageOrder,
      displayOrder,
      percentMemoryChange,
      ...(beforeMem !== undefined ? { beforeMemoryTotal: beforeMem } : {}),
      ...(afterMem !== undefined ? { afterMemoryTotal: afterMem } : {}),
      ...(memoryDeltaBytes !== undefined ? { memoryDeltaBytes } : {}),
    });
  },
});
