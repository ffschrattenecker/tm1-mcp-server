import { tm1NameEquals, tm1NameKey } from "../tm1-name.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";

/**
 * Compare a cube's display dimension order (`Cubes('C')/Dimensions`) against
 * its storage order (`tm1.DimensionsStorageOrder()`), ignoring `Sandboxes`
 * which leads display order when EnableSandboxDimension=T but never appears
 * in storage order.
 */
export function storageMatchesDisplayOrder(
  displayOrder: readonly string[],
  storageOrder: readonly string[],
): boolean {
  const displayNoSandbox = displayOrder.filter(
    (d) => !tm1NameEquals(d, "Sandboxes"),
  );
  return (
    displayNoSandbox.length === storageOrder.length &&
    displayNoSandbox.every((d, i) => tm1NameEquals(d, storageOrder[i]!))
  );
}

/**
 * Validate a proposed storage dimension order against the cube's current
 * storage order (case- and space-insensitive per TM1 naming rules).
 * Rejects `Sandboxes`, duplicates, missing dimensions, and unknown extras.
 */
export function validateStorageDimensionOrder(
  currentStorageOrder: readonly string[],
  proposedOrder: readonly string[],
): { canonical: string[]; changed: boolean } {
  const canonicalByKey = new Map<string, string>();
  for (const d of currentStorageOrder) {
    canonicalByKey.set(tm1NameKey(d), d);
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unknown: string[] = [];
  const canonical: string[] = [];

  for (const raw of proposedOrder) {
    if (tm1NameEquals(raw, "Sandboxes")) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: `"Sandboxes" cannot be included in storage dimensionOrder.`,
        hint: "Storage order never includes Sandboxes; pass only the cube's storage dimensions.",
      });
    }
    const key = tm1NameKey(raw);
    if (seen.has(key)) {
      duplicates.push(raw);
      continue;
    }
    seen.add(key);
    const serverName = canonicalByKey.get(key);
    if (serverName === undefined) {
      unknown.push(raw);
    } else {
      canonical.push(serverName);
    }
  }

  const missing = currentStorageOrder.filter((d) => !seen.has(tm1NameKey(d)));

  if (duplicates.length > 0 || unknown.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (duplicates.length > 0) {
      parts.push(`duplicate: ${duplicates.join(", ")}`);
    }
    if (unknown.length > 0) {
      parts.push(`unknown: ${unknown.join(", ")}`);
    }
    if (missing.length > 0) {
      parts.push(`missing: ${missing.join(", ")}`);
    }
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Invalid dimensionOrder (${parts.join("; ")}). Expected exact set: ${currentStorageOrder.join(", ")}.`,
      hint: `Pass all ${currentStorageOrder.length} storage dimensions in the desired order.`,
    });
  }

  const changed = canonical.some(
    (d, i) => !tm1NameEquals(d, currentStorageOrder[i] ?? ""),
  );
  return { canonical, changed };
}
