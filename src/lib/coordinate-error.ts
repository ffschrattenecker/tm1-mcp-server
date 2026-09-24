// One error for "this coordinate has the wrong number of elements", shared by
// every tool that addresses a cell positionally (get_cell_value, write_cells,
// check_writable_coords).
//
// The bare count ("4 given, 5 expected") was the least useful part of the old
// messages: the caller already knows it passed four. What it lacks is WHICH
// dimension it forgot — typically one it does not think of as part of the cube,
// such as a `Sandboxes` or `Version` dimension. So the message spells out the
// cube's dimension order, names the uncovered positions, and `details` pairs
// every dimension with the element that landed on it.
import { TM1Error, TM1ErrorCode } from "../types.js";

export function dimensionCountMismatch(
  cubeName: string,
  dimensions: readonly string[],
  elements: readonly string[],
): TM1Error {
  const missing = dimensions.slice(elements.length);
  const extra = elements.slice(dimensions.length);
  const gap =
    missing.length > 0
      ? ` No element for ${missing.length === 1 ? "dimension" : "dimensions"} (by position): ${missing.join(", ")}.`
      : ` ${extra.length} element(s) too many: ${extra.join(", ")}.`;
  return new TM1Error({
    code: TM1ErrorCode.VALIDATION_ERROR,
    message:
      `Cube '${cubeName}' has ${dimensions.length} dimensions but ${elements.length} element(s) were given.` +
      gap,
    hint: `Pass exactly one element per dimension, in this order: ${dimensions.join(", ")}. A forgotten dimension anywhere in the list shifts every later element onto the wrong one — check the pairing in details.`,
    details: JSON.stringify(
      dimensions.map((dimension, i) => ({
        dimension,
        element: elements[i] ?? null,
      })),
    ),
  });
}

// TM1 object names ignore case and spaces.
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/**
 * The caller's `dimensions` list against the cube's real ones. A tuple and its
 * dimension list can agree with each other and still both miss a dimension
 * the cube has — typically `Sandboxes`, which a server with
 * EnableSandboxDimension adds to every cube it creates. Returns undefined when
 * the lists match (same names, same order).
 */
export function dimensionListMismatch(
  cubeName: string,
  actual: readonly string[],
  given: readonly string[],
): TM1Error | undefined {
  const same =
    actual.length === given.length &&
    actual.every((d, i) => norm(d) === norm(given[i]!));
  if (same) return undefined;
  const givenSet = new Set(given.map(norm));
  const actualSet = new Set(actual.map(norm));
  const missing = actual.filter((d) => !givenSet.has(norm(d)));
  const unknown = given.filter((d) => !actualSet.has(norm(d)));
  const parts = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    unknown.length > 0 ? `not in the cube: ${unknown.join(", ")}` : "",
    missing.length === 0 && unknown.length === 0
      ? "same names, wrong order"
      : "",
  ].filter(Boolean);
  return new TM1Error({
    code: TM1ErrorCode.VALIDATION_ERROR,
    message: `dimensions does not match cube '${cubeName}' (${parts.join("; ")}).`,
    hint: `Pass dimensions exactly as the cube has them, and one element per dimension in this order: ${actual.join(", ")}.`,
  });
}
