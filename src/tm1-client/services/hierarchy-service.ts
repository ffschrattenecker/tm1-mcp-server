// Hierarchy domain service. Owns the element reads under
// /api/v1/Dimensions('{d}')/Hierarchies(...) that tools and caches need in
// bulk: the full structure (elements + weighted edges) and a name → type map.
// See docs/ARCHITECTURE.md for the layering.
import type { HierarchyElement } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { odataKey, pageClauseList } from "./odata-page.js";

/**
 * A hierarchy as a flat element list plus every parent→child edge with its
 * weight — the shape a structural comparison needs.
 */
export interface HierarchyStructure {
  elements: Array<{ name: string; type: HierarchyElement["type"] }>;
  edges: Array<{ parent: string; child: string; weight: number }>;
}

/** Elements per request in {@link HierarchyService.getStructure}. */
export const STRUCTURE_PAGE_SIZE = 50_000;

export class HierarchyService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Every element (name, type) and every edge (parent, child, weight) of a
   * hierarchy. Edges are read from each element's OUTGOING `Edges`
   * navigation, so an edge always arrives with its parent's row and paging by
   * element can neither split nor duplicate one.
   *
   * Paged by name in windows of `pageSize` (default
   * {@link STRUCTURE_PAGE_SIZE}). `$orderby=Name` is not optional — without
   * it `$skip` walks TM1's internal index order, which shifts on every
   * element create/delete and would duplicate or drop elements between pages.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name,Type&$expand=Edges($select=ComponentName,Weight)
   */
  async getStructure(
    dimensionName: string,
    hierarchyName: string,
    pageSize = STRUCTURE_PAGE_SIZE,
  ): Promise<HierarchyStructure> {
    const base =
      `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')` +
      `/Elements?$select=Name,Type&$expand=Edges($select=ComponentName,Weight)`;
    const out: HierarchyStructure = { elements: [], edges: [] };
    for (let skip = 0; ; skip += pageSize) {
      const clauses = pageClauseList({ top: pageSize, skip });
      const response = await this.http.request<{
        value?: Array<{
          Name: string;
          Type: string;
          Edges?: Array<{ ComponentName: string; Weight: number }>;
        }>;
      }>("GET", `${base}&${clauses.join("&")}`);
      const rows = response.value ?? [];
      for (const e of rows) {
        out.elements.push({
          name: e.Name,
          type: e.Type as HierarchyElement["type"],
        });
        for (const edge of e.Edges ?? [])
          out.edges.push({
            parent: e.Name,
            child: edge.ComponentName,
            weight: edge.Weight,
          });
      }
      if (rows.length < pageSize) return out;
    }
  }

  /**
   * Element name + type for a whole hierarchy — nothing else.
   *
   * Reads the Elements collection directly with `$select=Name,Type` — no
   * expand at all — which is the minimum payload for name → type resolution.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name,Type
   */
  async getElementTypes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: HierarchyElement["type"] }>> {
    const path =
      `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')` +
      `/Elements?$select=Name,Type`;
    const response = await this.http.request<{
      value?: Array<{ Name: string; Type: string }>;
    }>("GET", path);
    return (response.value ?? []).map((e) => ({
      name: e.Name,
      type: e.Type as HierarchyElement["type"],
    }));
  }
}
