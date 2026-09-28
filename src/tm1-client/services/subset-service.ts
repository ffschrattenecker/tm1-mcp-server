// Subset domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/{Subsets|PrivateSubsets} —
// list, get, create, update, delete. Subsets are either MDX-based
// (Expression) or static (Elements list); both shapes are handled here.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { Subset, SubsetCreate } from "../../types.js";
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

  /**
   * Create a subset, public or private (owned by the signed-in user). Either
   * MDX-based (expression) or static (elements). Mixed/empty inputs throw
   * VALIDATION_ERROR.
   * POST /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets
   */
  async create(
    dimensionName: string,
    hierarchyName: string,
    subset: SubsetCreate,
    isPrivate = false,
  ): Promise<void> {
    const path = `${this.base(dimensionName, hierarchyName)}/${isPrivate ? "PrivateSubsets" : "Subsets"}`;

    if (subset.expression && subset.elements && subset.elements.length > 0) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Subset must be either MDX-based (expression) OR static (elements), not both.",
      });
    }
    if (
      !subset.expression &&
      (!subset.elements || subset.elements.length === 0)
    ) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Subset requires either expression (MDX) or non-empty elements list.",
      });
    }

    const body: Record<string, unknown> = { Name: subset.name };
    if (subset.alias) body.Alias = subset.alias;
    if (subset.expression) {
      body.Expression = subset.expression;
    } else {
      body["Elements@odata.bind"] = this.bind(
        dimensionName,
        hierarchyName,
        subset.elements!,
      );
    }
    await this.http.request<void>("POST", path, body);
  }

  /**
   * Update an existing subset: its MDX, its static element list, or its alias.
   *
   * Measured on 11.8 and 12.5: a PATCH that binds Elements APPENDS to the
   * list (and freezes an MDX subset's result first), and one that also sends
   * `Expression: ""` is refused as "both a list of Elements and an
   * Expression". Replacing the list takes two calls: drop every element
   * reference, then bind the new ones. That pair is not atomic, and a bind
   * naming an unknown element fails with 404 after the list is already gone,
   * so on failure the old definition is written back.
   *
   * PATCH /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets('{s}')
   * DELETE …/Subsets('{s}')/Elements/$ref
   */
  async update(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    update: {
      expression?: string | undefined;
      elements?: string[] | undefined;
      alias?: string | undefined;
    },
    isPrivate = false,
  ): Promise<void> {
    const { expression, elements, alias } = update;
    if (expression !== undefined && elements !== undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Pass either expression (MDX) or elements (static list), not both.",
      });
    }
    if (
      expression === undefined &&
      elements === undefined &&
      alias === undefined
    ) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Nothing to update: pass expression, elements or alias.",
      });
    }

    const path = `${this.base(dimensionName, hierarchyName)}/${isPrivate ? "PrivateSubsets" : "Subsets"}('${odataKey(subsetName)}')`;
    const body: Record<string, unknown> = {};
    if (alias !== undefined) body.Alias = alias;
    if (elements === undefined) {
      if (expression !== undefined) body.Expression = expression;
      await this.http.request<void>("PATCH", path, body);
      return;
    }

    const before = await this.get(
      dimensionName,
      hierarchyName,
      subsetName,
      isPrivate,
    );
    await this.http.request<void>("DELETE", `${path}/Elements/$ref`);
    if (elements.length > 0)
      body["Elements@odata.bind"] = this.bind(
        dimensionName,
        hierarchyName,
        elements,
      );
    if (Object.keys(body).length === 0) return;
    try {
      await this.http.request<void>("PATCH", path, body);
    } catch (e) {
      const restore: Record<string, unknown> = before.expression
        ? { Expression: before.expression }
        : {
            "Elements@odata.bind": this.bind(
              dimensionName,
              hierarchyName,
              before.elements,
            ),
          };
      try {
        await this.http.request<void>("PATCH", path, restore);
      } catch {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message:
            `Subset '${subsetName}' was emptied and could not be restored after the update failed: ` +
            (e instanceof Error ? e.message : String(e)),
        });
      }
      throw e;
    }
  }

  /**
   * Delete a subset, public or private.
   * DELETE /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets('{s}')
   */
  async delete(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    isPrivate = false,
  ): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `${this.base(dimensionName, hierarchyName)}/${isPrivate ? "PrivateSubsets" : "Subsets"}('${odataKey(subsetName)}')`,
    );
  }
}
