import { z } from "zod";
import { FORMAT_SCHEMA, wrappedPageResponse, type Column } from "../format.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FindOrphanDimensionsResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

interface Orphan {
  name: string;
  hierarchies: string[];
}

export const registerFindOrphanDimensions = defineTool({
  name: "tm1_find_orphan_dimensions",
  description: [
    "Identify dimensions not referenced by any cube — a model-hygiene check. Computes the used-dimension set across all cubes (one OData call) and diffs against the full dimension list.",
    "Control dimensions ('}'-prefixed) excluded unless includeControl=true. Paginated (default 50/page). Inspect a hit with tm1_get_hierarchy or remove via tm1_delete_dimension.",
  ],
  annotations: READ_ONLY,
  output: FindOrphanDimensionsResultSchema,
  input: {
    includeControl: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Include control dimensions whose names start with '}' (default: false).",
      ),
    ...PAGINATION_SCHEMA,
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { includeControl, limit, offset, fetchAll, format },
    tm1Client,
  ) => {
    const [cubes, dimensions] = await Promise.all([
      tm1Client.cubes.list(),
      tm1Client.dimensions.list(),
    ]);

    const usedDims = new Set<string>();
    for (const c of cubes) {
      for (const d of c.dimensions ?? []) usedDims.add(d);
    }

    const candidates = includeControl
      ? dimensions
      : dimensions.filter((d) => !d.name.startsWith("}"));

    const orphans: Orphan[] = candidates
      .filter((d) => !usedDims.has(d.name))
      .map((d) => ({ name: d.name, hierarchies: d.hierarchies }));

    const page = paginate(orphans, limit, offset, fetchAll);
    const wrapper = {
      totalDimensions: candidates.length,
      totalCubes: cubes.length,
      orphanCount: orphans.length,
      includeControl,
      ...page,
    };
    const columns: Column<Orphan>[] = [
      { header: "name", get: (o) => o.name },
      { header: "hierarchies", get: (o) => o.hierarchies },
    ];
    return wrappedPageResponse(wrapper, page, format, {
      title: "Orphan dimensions",
      columns,
    });
  },
});
