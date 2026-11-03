// Dimension domain service. Owns the OData calls under /api/v1/Dimensions(...) —
// list, create, delete. Hierarchy and element operations live in their own
// sibling services. See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { Dimension } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { odataKey } from "./odata-page.js";

type DefaultMemberSource = "defined" | "single_root" | "first_root" | "index_1";

export interface DefaultMemberResolution {
  dimension: string;
  hierarchy: string;
  resolved: { name: string; level: number };
  source: DefaultMemberSource;
  confidence: "high" | "medium" | "low";
  alternatives?: {
    roots: Array<{ name: string; level: number }>;
    indexOne?: string;
  };
  warning?: string;
}

export interface DimensionListOpts {
  includeElementCount?: boolean;
}

export class DimensionService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List all dimensions with their hierarchy names.
   * GET /api/v1/Dimensions?$expand=Hierarchies($select=Name)
   *
   * When opts.includeElementCount is true, the expand also requests
   * `Elements($count=true;$top=0)` so each Hierarchy returns
   * `Elements@odata.count` without paying for the full element list.
   * Single round-trip, so sizing many dimensions costs one request.
   */
  async list(opts: DimensionListOpts = {}): Promise<Dimension[]> {
    const expand = opts.includeElementCount
      ? "Hierarchies($select=Name;$expand=Elements($count=true;$top=0))"
      : "Hierarchies($select=Name)";
    const path = `/api/v1/Dimensions?$expand=${expand}`;
    const response = await this.http.request<{
      value: Array<{
        Name: string;
        Hierarchies: Array<{
          Name: string;
          "Elements@odata.count"?: number;
        }>;
      }>;
    }>("GET", path);
    return response.value.map((d) => {
      const dim: Dimension = {
        name: d.Name,
        hierarchies: d.Hierarchies.map((h) => h.Name),
      };
      if (opts.includeElementCount) {
        dim.elementCounts = Object.fromEntries(
          d.Hierarchies.map((h) => [h.Name, h["Elements@odata.count"] ?? 0]),
        );
      }
      return dim;
    });
  }

  /**
   * Resolve a hierarchy's effective default member via a tiered cascade.
   * Designed for view/slicer construction where reading each hierarchy separately
   * across levels costs 3-8 round-trips per dimension.
   *
   * Tier 1: DefaultMember attribute (high confidence — explicitly maintained).
   * Tier 2: parentless roots (derived, not maintained) — single or multiple = medium.
   * Tier 3: insertion-order index 1 fallback (low confidence — flat/cyclic hierarchies).
   *
   * The `source` field tells callers whether the value is authoritative or inferred.
   * `alternatives.roots` is populated when multiple roots exist so callers can
   * disambiguate without a second round-trip.
   */
  async resolveDefaultMember(
    dimensionName: string,
    hierarchyName?: string,
  ): Promise<DefaultMemberResolution> {
    const hier = hierarchyName ?? dimensionName;
    const base = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hier)}')`;

    // Tier 1: explicit DefaultMember attribute.
    try {
      const dm = await this.http.request<
        { Name?: string; Level?: number } | undefined
      >("GET", `${base}/DefaultMember?$select=Name,Level`);
      if (dm && dm.Name) {
        return {
          dimension: dimensionName,
          hierarchy: hier,
          resolved: { name: dm.Name, level: dm.Level ?? 0 },
          source: "defined",
          confidence: "high",
        };
      }
    } catch (err) {
      // 404/204 = no default member set; fall through. Other errors bubble.
      if (!(
        err instanceof TM1Error &&
        (err.httpStatus === 404 || err.httpStatus === 204)
      )) {
        throw err;
      }
    }

    // Tier 2 & 3: enumerate elements with parents and classify.
    const elementsResp = await this.http.request<{
      value: Array<{
        Name: string;
        Level: number;
        Parents?: Array<{ Name: string }>;
      }>;
    }>(
      "GET",
      `${base}/Elements?$select=Name,Level&$expand=Parents($select=Name)`,
    );
    const elements = elementsResp?.value ?? [];
    if (elements.length === 0) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `Hierarchy '${dimensionName}.${hier}' has no elements or does not exist`,
      });
    }

    const roots = elements.filter((e) => !e.Parents || e.Parents.length === 0);
    // elements.length > 0 is guarded above
    const indexOne = elements[0]!.Name;

    if (roots.length === 1) {
      return {
        dimension: dimensionName,
        hierarchy: hier,
        resolved: { name: roots[0]!.Name, level: roots[0]!.Level },
        source: "single_root",
        // Derived server-fallback, not an explicitly maintained default → medium,
        // never tier-1 high. High is reserved for source "defined".
        confidence: "medium",
        warning:
          "DefaultMember attribute not maintained — resolved via unique parentless root.",
      };
    }

    if (roots.length > 1) {
      // Highest level first, then alphabetical for determinism.
      const sorted = [...roots].sort(
        (a, b) => b.Level - a.Level || a.Name.localeCompare(b.Name),
      );
      return {
        dimension: dimensionName,
        hierarchy: hier,
        resolved: { name: sorted[0]!.Name, level: sorted[0]!.Level },
        source: "first_root",
        confidence: "medium",
        alternatives: {
          roots: sorted.map((r) => ({ name: r.Name, level: r.Level })),
          indexOne,
        },
        warning: `DefaultMember not maintained — ${roots.length} parentless roots found; selected highest-level. Inspect alternatives.roots to disambiguate.`,
      };
    }

    // No roots: flat or cyclic hierarchy. TM1's own fallback is insertion-order index 1.
    return {
      dimension: dimensionName,
      hierarchy: hier,
      resolved: { name: indexOne, level: elements[0]!.Level ?? 0 },
      source: "index_1",
      confidence: "low",
      alternatives: { roots: [], indexOne },
      warning:
        "No parentless roots detected (flat or cyclic hierarchy). Falling back to first element by insertion order — verify suitability for view slicers.",
    };
  }
}
