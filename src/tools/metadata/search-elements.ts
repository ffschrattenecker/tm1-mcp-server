import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import { SearchElementsResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerSearchElements = defineTool({
  name: "tm1_search_elements",
  description: [
    "Find elements by a business term instead of guessing names: case-insensitive substring match on names and Alias values.",
    "String attributes listed in `attributes` are searched too (e.g. attributes=['City'] lets 'harbor' find K_0417 via City=Harborview). Unlike a name filter through tm1_rest_read, this matches aliases/attributes and spans a whole cube.",
    "Cost grows with dimension size and per searched attribute (~0.7 s on 160k elements), so String attributes are opt-in; tm1_rest_read on the hierarchy's ElementAttributes names them.",
    "Scope: cubeName searches every dimension of the cube (default hierarchies); dimensionName searches one hierarchy.",
    "Use before tm1_execute_mdx / tm1_sample_cells to resolve the exact element names a question refers to.",
    "Output: { searchTerm, dimensions: [{ dimension, hierarchy, total, truncated, elements: [{ name, type, level, matchedOn, matchedValue }] }] }. With cubeName, dimensions without hits are omitted. total counts all matches; elements is capped at topN — narrow the term when truncated.",
  ],
  annotations: READ_ONLY,
  output: SearchElementsResultSchema,
  input: {
    searchTerm: z
      .string()
      .min(1)
      .describe("Text to look for, case-insensitive substring."),
    cubeName: z
      .string()
      .optional()
      .describe(
        "Search all dimensions of this cube. Give cubeName or dimensionName.",
      ),
    dimensionName: z
      .string()
      .optional()
      .describe("Search only this dimension. Give cubeName or dimensionName."),
    hierarchyName: z
      .string()
      .optional()
      .describe(
        "Hierarchy with dimensionName. Defaults to the same-named hierarchy.",
      ),
    attributes: z
      .array(z.string())
      .optional()
      .describe(
        "String attributes to search as well. Names a dimension lacks are skipped.",
      ),
    topN: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(10)
      .describe("Max elements returned per dimension (default 10, max 100)."),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    {
      searchTerm,
      cubeName,
      dimensionName,
      hierarchyName,
      attributes,
      topN,
      format,
    },
    tm1Client,
  ) => {
    if ((cubeName === undefined) === (dimensionName === undefined)) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Provide exactly one of cubeName or dimensionName",
      });
    }
    const targets = cubeName
      ? (await tm1Client.cubes.getDimensionNames(cubeName)).map(
          (d) => [d, d] as const,
        )
      : [[dimensionName!, hierarchyName ?? dimensionName!] as const];
    const settled = await mapSettledWithConcurrency(targets, 4, ([dim, hier]) =>
      tm1Client.elements.searchElements(
        dim,
        hier,
        searchTerm,
        topN,
        attributes,
      ),
    );
    const dimensions = settled.map((r, i) => {
      if (r.status === "rejected") throw r.reason;
      const [dimension, hierarchy] = targets[i]!;
      return {
        dimension,
        hierarchy,
        total: r.value.total,
        truncated: r.value.total > r.value.elements.length,
        elements: r.value.elements,
      };
    });
    // Cube-wide, a dimension without hits only costs tokens.
    const result = {
      searchTerm,
      dimensions: cubeName ? dimensions.filter((d) => d.total > 0) : dimensions,
    };
    type Row = {
      dimension: string;
      name: string;
      type: string;
      level: number;
      matchedOn: string;
      matchedValue: string;
    };
    const columns = columnsOf<Row>([
      "dimension",
      "name",
      "type",
      "level",
      "matchedOn",
      "matchedValue",
    ]);
    return payloadResponse(result, format, (r) => {
      const rows = r.dimensions.flatMap((d) =>
        d.elements.map((e) => ({ dimension: d.dimension, ...e })),
      );
      const counts = r.dimensions
        .filter((d) => d.total > 0)
        .map((d) => `${d.dimension}: ${d.total}`)
        .join(", ");
      return `## Elements matching "${r.searchTerm}"\n\n${counts || "_no matches_"}\n\n${renderTable(rows, columns)}`;
    });
  },
});
