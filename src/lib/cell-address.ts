// Resolve a caller's named-dimension cell address against the cube's real
// dimension list, before anything is written. Shared by tm1_write_cells and
// tm1_check_writable_coords so the pre-write check and the write agree on
// which cell a coordinate means.
//
// Why: the write path builds an MDX tuple over the dimensions the caller
// names, and TM1 fills every dimension left out with its default member —
// without an error. Verified on 11.8.03500: a write that left out a measure
// dimension landed on its first element and overwrote a value there.
//
// The one dimension that may be left out is the `Sandboxes` dimension that
// `EnableSandboxDimension=true` adds to every cube: callers rarely think of it
// as part of the cube. It is bound to `Base` explicitly rather than left to
// TM1's default member, because the default is only known to be `Base` while
// `Base` is the dimension's sole member — a sandbox with
// IncludeInSandboxDimension=true adds another. This server never sends
// `!sandbox=`, so `Base` is also what every read through it sees. A cube with
// a regular dimension that happens to be named Sandboxes but has no `Base`
// fails loudly with TM1's "member not found", never silently.
import { TM1Error, TM1ErrorCode } from "../types.js";

export const SANDBOX_DIMENSION = "Sandboxes";
export const BASE_SANDBOX = "Base";

export interface ResolvedAddress {
  /** The cube's dimensions, in cube order. */
  dimensions: string[];
  /** Maps a caller's elements (in the caller's dimension order) to cube order. */
  toCubeOrder: (elements: readonly string[]) => string[];
  /** Set when `Sandboxes` was left out and bound to `Base`. */
  sandboxDefaulted?: typeof BASE_SANDBOX;
}

export function resolveCellAddress(
  cubeName: string,
  cubeDimensions: readonly string[],
  given: readonly string[],
): ResolvedAddress {
  const byLower = new Map(cubeDimensions.map((d, i) => [d.toLowerCase(), i]));
  const positions: number[] = [];
  const unknown: string[] = [];
  const duplicate: string[] = [];
  const seen = new Set<number>();
  for (const name of given) {
    const pos = byLower.get(name.toLowerCase());
    if (pos === undefined) unknown.push(name);
    else if (seen.has(pos)) duplicate.push(name);
    else seen.add(pos);
    positions.push(pos ?? -1);
  }
  const missing = cubeDimensions.filter((_, i) => !seen.has(i));
  const sandboxPos = cubeDimensions.findIndex(
    (d) => d.toLowerCase() === SANDBOX_DIMENSION.toLowerCase(),
  );
  const onlySandboxMissing =
    missing.length === 1 && sandboxPos >= 0 && !seen.has(sandboxPos);

  const problems: string[] = [];
  if (unknown.length > 0)
    problems.push(`not in the cube: ${unknown.join(", ")}`);
  if (duplicate.length > 0)
    problems.push(`listed twice: ${duplicate.join(", ")}`);
  if (missing.length > 0 && !onlySandboxMissing)
    problems.push(
      `missing: ${missing.filter((d) => d !== cubeDimensions[sandboxPos]).join(", ")}`,
    );
  if (problems.length > 0) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Dimensions do not match cube '${cubeName}' — ${problems.join("; ")}. Nothing was written.`,
      hint: `Name every dimension of the cube (any order): ${cubeDimensions.join(", ")}. A dimension left out is not ignored — TM1 writes into its default member.${sandboxPos >= 0 ? ` Only ${SANDBOX_DIMENSION} may be left out; it is then bound to ${BASE_SANDBOX}.` : ""}`,
      details: JSON.stringify({ cubeDimensions, given }),
    });
  }

  return {
    dimensions: [...cubeDimensions],
    toCubeOrder: (elements) => {
      const out = new Array<string>(cubeDimensions.length);
      elements.forEach((e, i) => {
        out[positions[i]!] = e;
      });
      if (onlySandboxMissing) out[sandboxPos] = BASE_SANDBOX;
      return out;
    },
    ...(onlySandboxMissing ? { sandboxDefaulted: BASE_SANDBOX } : {}),
  };
}
