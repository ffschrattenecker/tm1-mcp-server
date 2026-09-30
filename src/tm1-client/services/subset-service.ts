// Subset domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/{Subsets|PrivateSubsets} —
// list, get, create, update, delete. Subsets are either MDX-based
// (Expression) or static (Elements list); both shapes are handled here.
//
// See docs/ARCHITECTURE.md for the layering.
import type { Subset } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { rethrowIfSystemic } from "./fallback.js";
import { odataKey } from "./odata-page.js";

export class SubsetService {
  constructor(private readonly http: TM1HttpClient) {}

  private base(dimensionName: string, hierarchyName: string): string {
    return `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')`;
  }

  private bind(
    dimensionName: string,
    hierarchyName: string,
    elements: string[],
  ): string[] {
    return elements.map(
      (e) =>
        `Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(e)}')`,
    );
  }

  /**
   * List public + private subsets of a hierarchy.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets
   */
  async list(dimensionName: string, hierarchyName: string): Promise<Subset[]> {
    const result: Subset[] = [];
    const fetchScope = async (
      segment: "Subsets" | "PrivateSubsets",
      isPrivate: boolean,
    ) => {
      try {
        const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/${segment}?$select=Name,Expression,Alias`;
        const response = await this.http.request<{
          value: Array<{ Name: string; Expression?: string; Alias?: string }>;
        }>("GET", path);
        for (const s of response.value) {
          result.push({
            name: s.Name,
            dimensionName,
            hierarchyName,
            private: isPrivate,
            expression: s.Expression || undefined,
            elements: [],
            alias: s.Alias || undefined,
          });
        }
      } catch (e) {
        rethrowIfSystemic(e);
        // scope may not exist
      }
    };
    await fetchScope("Subsets", false);
    await fetchScope("PrivateSubsets", true);
    return result;
  }

  /**
   * Get a single subset incl. resolved Elements.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets('{s}')?$expand=Elements($select=Name)
   */
  async get(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    isPrivate = false,
  ): Promise<Subset> {
    const segment = isPrivate ? "PrivateSubsets" : "Subsets";
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/${segment}('${odataKey(subsetName)}')?$expand=Elements($select=Name)&$select=Name,Expression,Alias`;
    const response = await this.http.request<{
      Name: string;
      Expression?: string;
      Alias?: string;
      Elements?: Array<{ Name: string }>;
    }>("GET", path);
    return {
      name: response.Name,
      dimensionName,
      hierarchyName,
      private: isPrivate,
      expression: response.Expression || undefined,
      elements: (response.Elements ?? []).map((e) => e.Name),
      alias: response.Alias || undefined,
    };
  }
}
