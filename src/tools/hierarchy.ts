// Optional `hierarchyName` that defaults to the dimension's same-named
// hierarchy. Every TM1 dimension has one, and it is what callers mean in the
// overwhelming majority of calls — omitting the field was the single most
// common schema error (-32602) in recorded usage.
//
// Pattern in a tool registration:
//
//   input: { dimensionName: z.string(), ...HIERARCHY_NAME_OPTIONAL, ... },
//   handler: async ({ dimensionName, hierarchyName }) => {
//     const hierarchy = resolveHierarchy(dimensionName, hierarchyName);
//     ...
//   }
//
// Resolve before any confirm check or service call so both see the effective
// name. Tools whose hierarchy is the subject of a create/delete keep the field
// required: the default hierarchy cannot be created or deleted on its own.
import { z } from "zod";

export const HIERARCHY_NAME_OPTIONAL = {
  hierarchyName: z
    .string()
    .optional()
    .describe(
      "Hierarchy within the dimension. Defaults to the dimension's same-named hierarchy.",
    ),
};

export function resolveHierarchy(
  dimensionName: string,
  hierarchyName: string | undefined,
): string {
  return hierarchyName ?? dimensionName;
}
