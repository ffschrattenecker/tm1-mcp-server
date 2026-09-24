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
