// Shared OData paging clause builder and key encoders for service-layer
// query strings.
//
// Lives in the service layer on purpose: tools cannot reach the transport, so
// every OData query fragment stays inside a service. Nothing here interpolates
// a caller string without escaping it.

export interface PageOpts {
  /** `$top` — page size. Positive integer (comes from a Zod-validated `limit`). */
  top: number;
  /** `$skip` — items to skip. Non-negative integer (Zod-validated `offset`). */
  skip: number;
}

/**
 * The paging clauses as separate `$…=…` fragments, in a fixed order, sorted by
 * `Name`. Returns `[]` when no page was requested. The sort is mandatory:
 * TM1's internal index order shifts on create/delete, so `$skip` without it
 * would silently duplicate or drop rows across pages.
 *
 * Use this for nested `$expand(...)` option lists (joined with `;`).
 */
export function pageClauseList(page: PageOpts | undefined): string[] {
  if (page === undefined) return [];
  return [
    "$orderby=Name",
    `$top=${page.top}`,
    `$skip=${page.skip}`,
    "$count=true",
  ];
}

/** Double `'` per OData literal rules so a caller string cannot break out of a literal. */
export function escapeOdataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Entity-key segment for a URL path: `Cubes('${odataKey(name)}')`. Doubles `'`,
 * then percent-encodes, so `#`, `?`, `%`, `&` and `/` in a TM1 name stay inside
 * the key. The one encoder for every service — see scripts/check-conventions.mjs
 * (no-local-enc).
 */
export function odataKey(value: string): string {
  return encodeURIComponent(escapeOdataLiteral(String(value)));
}
