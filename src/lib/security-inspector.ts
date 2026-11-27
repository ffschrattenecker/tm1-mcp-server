import type { TM1Client } from "../tm1-client.js";
import { escapeMdxName } from "./mdx.js";
import {
  TM1Error,
  TM1ErrorCode,
  type ObjectSecurityRight,
  type SecurityRight,
} from "../types.js";

export const RIGHT_RANK: Readonly<Record<string, number>> = {
  NONE: 0,
  READ: 1,
  WRITE: 2,
  RESERVE: 3,
  LOCK: 4,
  ADMIN: 5,
};

const SPECIAL_GROUP_NAMES = new Set(["admin", "dataadmin", "securityadmin"]);

export function normalizeRight(raw: unknown): SecurityRight {
  if (typeof raw !== "string") return "NONE";
  const upper = raw.trim().toUpperCase();
  if (upper in RIGHT_RANK) return upper as SecurityRight;
  if (upper === "UNRESTRICTED") return "UNRESTRICTED";
  return "NONE";
}

export function resolveEffectiveRight(
  byGroup: Record<string, string>,
  opts: { isAdmin: boolean },
): { effective: SecurityRight; grantedBy: string[] } {
  if (opts.isAdmin) {
    return { effective: "ADMIN", grantedBy: ["ADMIN"] };
  }
  let bestRank = 0;
  let bestRight: SecurityRight = "NONE";
  for (const right of Object.values(byGroup)) {
    const norm = normalizeRight(right);
    const rank = RIGHT_RANK[norm] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      bestRight = norm;
    }
  }
  if (bestRank === 0) {
    return { effective: "NONE", grantedBy: [] };
  }
  const grantedBy = Object.entries(byGroup)
    .filter(([, r]) => (RIGHT_RANK[normalizeRight(r)] ?? 0) === bestRank)
    .map(([g]) => g);
  return { effective: bestRight, grantedBy };
}

export interface SecuritySection {
  securityCubeExists: boolean;
  dimensionName?: string;
  truncated?: boolean;
  error?: string;
  items: ObjectSecurityRight[];
}

export interface SecurityInspectionResult {
  user: {
    name: string;
    friendlyName?: string;
    type?: string;
    enabled?: boolean;
    groups: string[];
    isAdmin: boolean;
    specialGroups: string[];
  };
  cubes?: SecuritySection;
  dimensions?: SecuritySection;
  elements?: SecuritySection;
  processes?: SecuritySection;
  warnings?: string[];
}

function isDeniedError(err: unknown): boolean {
  if (err instanceof TM1Error) {
    if (err.code === TM1ErrorCode.PERMISSION_DENIED) return true;
    if ((err.details ?? "").includes("ObjectSecurityNoReadRights")) return true;
  }
  return (
    err instanceof Error && err.message.includes("ObjectSecurityNoReadRights")
  );
}

async function probeCubeExistsSafe(
  tm1Client: TM1Client,
  cubeName: string,
): Promise<boolean> {
  try {
    return await tm1Client.cubes.exists(cubeName);
  } catch (err) {
    if (
      err instanceof TM1Error &&
      (err.code === TM1ErrorCode.CONNECTION_FAILED ||
        err.code === TM1ErrorCode.AUTH_FAILED ||
        err.code === TM1ErrorCode.LOCK_TIMEOUT)
    ) {
      throw err;
    }
    return false;
  }
}

export async function inspectEffectiveSecurity(
  tm1Client: TM1Client,
  opts: {
    userName?: string | undefined;
    cubeName?: string | undefined;
    dimensionName?: string | undefined;
    elementNames?: string[] | undefined;
    processName?: string | undefined;
    includeAllObjects?: boolean | undefined;
    limit?: number | undefined;
  } = {},
): Promise<SecurityInspectionResult> {
  if (
    opts.elementNames &&
    opts.elementNames.length > 0 &&
    !opts.dimensionName
  ) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: "elementNames requires dimensionName.",
      hint: "Pass dimensionName alongside elementNames to inspect }ElementSecurity_<dim>.",
    });
  }

  const user = await tm1Client.security.getUser(opts.userName);
  const groups = (user.Groups ?? []).map((g) => g.Name);
  const specialGroups = groups.filter((g) =>
    SPECIAL_GROUP_NAMES.has(g.toLowerCase()),
  );
  const isAdmin =
    user.Type === "Admin" || groups.some((g) => g.toLowerCase() === "admin");

  const hasTarget = Boolean(
    opts.cubeName || opts.dimensionName || opts.processName,
  );
  const inspectAll = opts.includeAllObjects === true || !hasTarget;
  const limit = opts.limit ?? 100;
  const warnings: string[] = [];

  if (specialGroups.some((g) => g.toLowerCase() === "dataadmin")) {
    warnings.push(
      "User belongs to DataAdmin — TM1 grants full data read/write privileges across cubes regardless of object security.",
    );
  }
  if (specialGroups.some((g) => g.toLowerCase() === "securityadmin")) {
    warnings.push(
      "User belongs to SecurityAdmin — TM1 grants privileges to manage security objects.",
    );
  }

  const querySecurityCube = async (params: {
    securityCube: string;
    objectDim: string;
    targets?: string[];
    dimensionName?: string;
    isElementSecurity?: boolean;
    skipControlPrefix?: boolean;
  }): Promise<SecuritySection> => {
    let exists: boolean;
    try {
      exists = await tm1Client.cubes.exists(params.securityCube);
    } catch (err) {
      if (isDeniedError(err)) {
        return {
          securityCubeExists: true,
          ...(params.dimensionName
            ? { dimensionName: params.dimensionName }
            : {}),
          error: `Permission denied reading ${params.securityCube}.`,
          items: [],
        };
      }
      throw err;
    }

    if (!exists) {
      if (params.isElementSecurity) {
        warnings.push(
          `${params.securityCube} does not exist — element-level security is not enabled on dimension '${params.dimensionName ?? params.objectDim}' (effective element access is UNRESTRICTED for non-admin users, subject to cube/dimension rights).`,
        );
        return {
          securityCubeExists: false,
          ...(params.dimensionName
            ? { dimensionName: params.dimensionName }
            : {}),
          items: (params.targets ?? []).map((t) => ({
            objectName: t,
            effective: isAdmin ? "ADMIN" : "UNRESTRICTED",
            grantedBy: isAdmin ? ["ADMIN"] : [],
            byGroup: {},
          })),
        };
      }
      warnings.push(`${params.securityCube} does not exist on this server.`);
      return {
        securityCubeExists: false,
        items: [],
      };
    }

    if (groups.length === 0) {
      if (!params.targets || params.targets.length === 0) {
        warnings.push(
          `User '${user.Name}' belongs to no groups — object rights in ${params.securityCube} default to ${isAdmin ? "ADMIN" : "NONE"}.`,
        );
        return {
          securityCubeExists: true,
          ...(params.dimensionName
            ? { dimensionName: params.dimensionName }
            : {}),
          items: [],
        };
      }
      return {
        securityCubeExists: true,
        ...(params.dimensionName
          ? { dimensionName: params.dimensionName }
          : {}),
        items: params.targets.map((t) => ({
          objectName: t,
          effective: isAdmin ? "ADMIN" : "NONE",
          grantedBy: isAdmin ? ["ADMIN"] : [],
          byGroup: {},
        })),
      };
    }

    const escCube = escapeMdxName(params.securityCube);
    const escObj = escapeMdxName(params.objectDim);
    const cols = groups.map((g) => `[}Groups].[${escapeMdxName(g)}]`).join(",");

    let rowSet: string;
    if (params.targets && params.targets.length > 0) {
      rowSet = `{${params.targets.map((t) => `[${escObj}].[${escapeMdxName(t)}]`).join(",")}}`;
    } else if (params.skipControlPrefix) {
      rowSet = `{HEAD(FILTER(TM1SUBSETALL([${escObj}].[${escObj}]), LEFT([${escObj}].CurrentMember.Name, 1) <> "}"), ${limit + 1})}`;
    } else {
      rowSet = `{HEAD(TM1SUBSETALL([${escObj}].[${escObj}]), ${limit + 1})}`;
    }

    const mdx = `SELECT {${cols}} ON COLUMNS, ${rowSet} ON ROWS FROM [${escCube}]`;

    let result;
    try {
      result = await tm1Client.cells.executeMdx(mdx);
    } catch (err) {
      if (isDeniedError(err)) {
        return {
          securityCubeExists: true,
          ...(params.dimensionName
            ? { dimensionName: params.dimensionName }
            : {}),
          error: `Permission denied querying ${params.securityCube}.`,
          items: [],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        securityCubeExists: true,
        ...(params.dimensionName
          ? { dimensionName: params.dimensionName }
          : {}),
        error: msg,
        items: [],
      };
    }

    const colGroups = (result.axes[0]?.tuples ?? []).map(
      (t, idx) => t.members[0]?.name ?? groups[idx] ?? `group_${idx}`,
    );
    const allRowNames = (result.axes[1]?.tuples ?? []).map(
      (t, idx) => t.members[0]?.name ?? `row_${idx}`,
    );
    const isListMode = !params.targets || params.targets.length === 0;
    const truncated = isListMode && allRowNames.length > limit;
    const rowNames = truncated ? allRowNames.slice(0, limit) : allRowNames;
    const groupCount = colGroups.length;

    const items: ObjectSecurityRight[] = rowNames.map((objName, rIdx) => {
      const byGroup: Record<string, string> = {};
      for (let cIdx = 0; cIdx < groupCount; cIdx++) {
        const cell = result.cells[rIdx * groupCount + cIdx];
        const val = normalizeRight(cell?.value);
        byGroup[colGroups[cIdx]!] = val;
      }
      const resolved = resolveEffectiveRight(byGroup, { isAdmin });
      return {
        objectName: objName,
        effective: resolved.effective,
        grantedBy: resolved.grantedBy,
        byGroup,
      };
    });

    return {
      securityCubeExists: true,
      ...(params.dimensionName ? { dimensionName: params.dimensionName } : {}),
      ...(truncated ? { truncated: true } : {}),
      items,
    };
  };

  const tasks: {
    cubes?: Promise<SecuritySection>;
    dimensions?: Promise<SecuritySection>;
    elements?: Promise<SecuritySection>;
    processes?: Promise<SecuritySection>;
    cellSec?: Promise<boolean>;
    overlaySec?: Promise<boolean>;
  } = {};

  if (opts.cubeName || inspectAll) {
    tasks.cubes = querySecurityCube({
      securityCube: "}CubeSecurity",
      objectDim: "}Cubes",
      ...(opts.cubeName ? { targets: [opts.cubeName] } : {}),
      skipControlPrefix: true,
    });
  }
  if (opts.cubeName) {
    tasks.cellSec = probeCubeExistsSafe(
      tm1Client,
      `}CellSecurity_${opts.cubeName}`,
    );
    tasks.overlaySec = probeCubeExistsSafe(
      tm1Client,
      `}SecurityOverlayGlobal_${opts.cubeName}`,
    );
  }
  if (opts.dimensionName || inspectAll) {
    tasks.dimensions = querySecurityCube({
      securityCube: "}DimensionSecurity",
      objectDim: "}Dimensions",
      ...(opts.dimensionName ? { targets: [opts.dimensionName] } : {}),
      skipControlPrefix: true,
    });
  }
  if (opts.dimensionName) {
    tasks.elements = querySecurityCube({
      securityCube: `}ElementSecurity_${opts.dimensionName}`,
      objectDim: opts.dimensionName,
      dimensionName: opts.dimensionName,
      isElementSecurity: true,
      ...(opts.elementNames && opts.elementNames.length > 0
        ? { targets: opts.elementNames }
        : {}),
    });
  }
  if (opts.processName || inspectAll) {
    tasks.processes = querySecurityCube({
      securityCube: "}ProcessSecurity",
      objectDim: "}Processes",
      ...(opts.processName ? { targets: [opts.processName] } : {}),
      skipControlPrefix: true,
    });
  }

  const [cubes, dimensions, elements, processes, cellSec, overlaySec] =
    await Promise.all([
      tasks.cubes,
      tasks.dimensions,
      tasks.elements,
      tasks.processes,
      tasks.cellSec,
      tasks.overlaySec,
    ]);

  if (opts.cubeName && cubes && cubes.items.length > 0) {
    if (cellSec) {
      cubes.items[0]!.cellSecurityActive = true;
      warnings.push(
        `}CellSecurity_${opts.cubeName} exists — cell-level security rules may further restrict individual cells for non-ADMIN users.`,
      );
    }
    if (overlaySec) {
      cubes.items[0]!.securityOverlayActive = true;
      warnings.push(
        `}SecurityOverlayGlobal_${opts.cubeName} exists — security overlays can restrict cells to READ-only for non-ADMIN users.`,
      );
    }
  }

  return {
    user: {
      name: user.Name,
      ...(user.FriendlyName !== undefined
        ? { friendlyName: user.FriendlyName }
        : {}),
      ...(user.Type !== undefined ? { type: user.Type } : {}),
      ...(user.Enabled !== undefined ? { enabled: user.Enabled } : {}),
      groups,
      isAdmin,
      specialGroups,
    },
    ...(cubes !== undefined ? { cubes } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(elements !== undefined ? { elements } : {}),
    ...(processes !== undefined ? { processes } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
