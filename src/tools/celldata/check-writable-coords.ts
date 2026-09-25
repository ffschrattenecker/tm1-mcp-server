import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { rethrowIfSystemic } from "../../tm1-client/services/fallback.js";
import { READ_ONLY } from "../annotations.js";
import { WritableCoordsResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { dimensionCountMismatch } from "../../lib/coordinate-error.js";
import { resolveCellAddress } from "../../lib/cell-address.js";

interface CoordCheck {
  dimension: string;
  element: string;
  exists: boolean;
  type: "Numeric" | "String" | "Consolidated" | "(missing)";
  isNLevel: boolean;
}

export const registerCheckWritableCoords = defineTool({
  name: "tm1_check_writable_coords",
  description:
    "Pre-flight check before CellPutN/CellPutS. Verifies (1) every coord element exists, (2) every element is N-Level (writes to Consolidated elements silent-fail), and (3) whether the target cube has rules that may overlap the coord. Returns per-coord status + a rule-overlap warning. Use before writing cells in a TI process or via tm1_write_cells; pass the same dimensions list as the write to check exactly the cell it will address.",
  annotations: READ_ONLY,
  output: WritableCoordsResultSchema,
  input: {
    cubeName: z.string().describe("Target cube name"),
    coords: z
      .array(z.string())
      .describe(
        "Element name per dimension: in cube dimension order, or in the order of dimensions when given.",
      ),
    dimensions: z
      .array(z.string())
      .optional()
      .describe(
        "Dimension names for coords, any order — as passed to tm1_write_cells. Every cube dimension except Sandboxes (bound to Base) must be named.",
      ),
  },
  handler: async ({ cubeName, coords: given, dimensions }, tm1Client) => {
    const cubes = await tm1Client.cubes.list();
    const cubeMeta = cubes.find(
      (c) => c.name.toLowerCase() === cubeName.toLowerCase(),
    );
    if (!cubeMeta) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `Cube '${cubeName}' not found`,
      });
    }
    const dims = cubeMeta.dimensions;
    let coords = given;
    let sandboxDefaulted: string | undefined;
    if (dimensions !== undefined) {
      if (given.length !== dimensions.length) {
        throw dimensionCountMismatch(cubeName, dimensions, given);
      }
      const address = resolveCellAddress(cubeName, dims, dimensions);
      coords = address.toCubeOrder(given);
      sandboxDefaulted = address.sandboxDefaulted;
    } else if (coords.length !== dims.length) {
      throw dimensionCountMismatch(cubeName, dims, coords);
    }

    const checks: CoordCheck[] = await Promise.all(
      dims.map(async (dim, idx) => {
        // coords.length === dims.length is guarded above
        const element = coords[idx]!;
        try {
          const hier = await tm1Client.hierarchies.get(dim, dim);
          const el = hier.elements.find(
            (e) => e.name.toLowerCase() === element.toLowerCase(),
          );
          if (!el) {
            return {
              dimension: dim,
              element,
              exists: false,
              type: "(missing)" as const,
              isNLevel: false,
            };
          }
          return {
            dimension: dim,
            element: el.name,
            exists: true,
            type: el.type,
            isNLevel: el.type !== "Consolidated",
          };
        } catch (e) {
          // A transport/auth outage must not masquerade as a missing element —
          // that would tell the agent to "repair" coordinates that are actually
          // fine. Only genuine lookup failures (NOT_FOUND) fall through.
          rethrowIfSystemic(e);
          return {
            dimension: dim,
            element,
            exists: false,
            type: "(missing)" as const,
            isNLevel: false,
          };
        }
      }),
    );

    let ruleOverlapWarn: {
      hasRules: boolean;
      ruleLines: number;
      note: string;
    } = {
      hasRules: false,
      ruleLines: 0,
      note: "",
    };
    try {
      const rules = await tm1Client.cubes.getRules(cubeName);
      const ruleText = (rules.rulesText ?? "").trim();
      if (ruleText) {
        ruleOverlapWarn = {
          hasRules: true,
          ruleLines: ruleText.split(/\r?\n/).length,
          note: "Cube has rules. CellPutN/S to a coord that the rule computes will be silently overridden by the rule. Inspect the rules manually for LHS pattern overlap with this coord.",
        };
      }
    } catch (e) {
      // A missing/rule-less cube legitimately leaves the default; a systemic
      // outage must surface rather than silently claim the cube has no rules.
      rethrowIfSystemic(e);
    }

    const allExist = checks.every((c) => c.exists);
    const allNLevel = checks.every((c) => c.isNLevel);
    const writable = allExist && allNLevel;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              cube: cubeName,
              writable,
              allElementsExist: allExist,
              allElementsNLevel: allNLevel,
              coords: checks,
              ruleOverlapWarn,
              ...(sandboxDefaulted ? { sandboxDefaulted } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
