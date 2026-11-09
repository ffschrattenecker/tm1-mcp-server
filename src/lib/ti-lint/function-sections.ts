/**
 * Which TI procedure a function may, or should, run in.
 *
 * Section restrictions come from IBM's per-function references, as surveyed by
 * deutschebahn/linti (docs/function-placement.md, Apache-2.0). IBM's general
 * guidance allows any function in any procedure; a function reference that
 * restricts it wins. Functions whose references are silent or contradictory
 * (ExecuteProcess, ItemReject, DimensionElementDelete, …) are deliberately
 * absent, as are the *Direct edits, which are valid everywhere.
 */
import type { TiTab } from "../complexity/process-metrics.js";

export interface Placement {
  /** Procedures the function should not appear in. */
  badIn: ReadonlyArray<TiTab>;
  /** error = IBM documents the restriction; warn = it runs, but not as intended. */
  severity: "error" | "warn";
  /**
   * The cost is repetition: Metadata and Data run once per source record.
   * A call inside an If there is usually a deliberate one-off, so it is not reported.
   */
  perRecord?: boolean;
  reason: string;
}

const ONCE: Omit<Placement, "reason"> = {
  badIn: ["metadata", "data"],
  severity: "warn",
  perRecord: true,
};

const ONCE_REASON =
  "is a once-per-process operation, but Metadata and Data run once per source record. Move it to the Prolog or Epilog.";

const entries: Array<[string[], Placement]> = [
  [
    ["DimensionElementInsert", "HierarchyElementInsert"],
    {
      badIn: ["data", "epilog"],
      severity: "error",
      reason:
        "is restricted by IBM to the Prolog and Metadata. Insert in Metadata, or use the *Direct variant in Data.",
    },
  ],
  [
    ["DimensionElementComponentAdd", "HierarchyElementComponentAdd"],
    {
      badIn: ["epilog"],
      severity: "error",
      reason:
        "is not allowed in the Epilog (IBM). Add components in Metadata, or use the *Direct variant.",
    },
  ],
  [
    ["DisableBulkLoadMode"],
    {
      badIn: ["prolog", "metadata", "data"],
      severity: "error",
      reason:
        "belongs on the last line of the Epilog (IBM): bulk load mode holds the server for this process until it is disabled.",
    },
  ],
  [
    ["AddInfoCubeRestriction"],
    {
      badIn: ["metadata", "data", "epilog"],
      severity: "error",
      reason: "must be placed in the Prolog (IBM).",
    },
  ],
  [
    ["DisableMTQViewConstruct"],
    {
      badIn: ["metadata", "data"],
      severity: "error",
      reason: "must be in the Prolog, or on the last line of the Epilog (IBM).",
    },
  ],
  [
    ["ItemSkip"],
    {
      badIn: ["prolog", "epilog"],
      severity: "error",
      reason:
        "skips the current source record, so it only means something in Metadata or Data.",
    },
  ],
  [
    [
      "AddClient",
      "DeleteClient",
      "AddGroup",
      "DeleteGroup",
      "CellSecurityCubeCreate",
      "CellSecurityCubeDestroy",
    ],
    {
      badIn: ["data", "epilog"],
      severity: "warn",
      reason:
        "changes metadata, and IBM says not to use it in Data or Epilog; client and group changes take effect when the Metadata procedure ends.",
    },
  ],
  [
    ["DimensionUpdateDirect", "HierarchyUpdateDirect"],
    {
      ...ONCE,
      reason:
        "makes a full copy of the dimension first (IBM), and Metadata and Data repeat that cost per source record. Call it in the Prolog or Epilog.",
    },
  ],
  [
    [
      "DimensionDeleteAllElements",
      "DimensionDeleteElements",
      "HierarchyDeleteAllElements",
      "HierarchyDeleteElements",
    ],
    {
      badIn: ["metadata", "data", "epilog"],
      severity: "warn",
      perRecord: true,
      reason:
        "empties the dimension: in Metadata or Data once per source record, in the Epilog after the process built it. Call it in the Prolog.",
    },
  ],
  [
    [
      "CubeClearData",
      "ViewZeroOut",
      "CubeProcessFeeders",
      "SecurityRefresh",
      "SaveDataAll",
      "CubeSaveData",
      "CubeCreate",
      "CubeDestroy",
      "DimensionCreate",
      "DimensionDestroy",
      "HierarchyCreate",
      "HierarchyDestroy",
      "ViewCreate",
      "ViewDestroy",
      "ViewCreateByMDX",
      "SubsetCreate",
      "SubsetDestroy",
      "SubsetCreateByMDX",
      "RefreshMdxHierarchy",
      "CubeSetLogChanges",
      "EnableBulkLoadMode",
      "ASCIIDelete",
      "DimensionSortOrder",
      "HierarchySortOrder",
    ],
    { ...ONCE, reason: ONCE_REASON },
  ],
  [
    ["EnableMTQViewConstruct"],
    {
      badIn: ["metadata", "data"],
      severity: "warn",
      reason: "is meant for the Prolog or Epilog (IBM).",
    },
  ],
  [
    ["SetInputCharacterSet"],
    {
      badIn: ["metadata", "data", "epilog"],
      severity: "warn",
      reason:
        "only affects how the source is opened, which happens after the Prolog. Call it in the Prolog.",
    },
  ],
];

/** Lowercased function name → placement rule. */
export const FUNCTION_SECTIONS: ReadonlyMap<string, Placement> = new Map(
  entries.flatMap(([names, p]) =>
    names.map((n) => [n.toLowerCase(), p] as const),
  ),
);
