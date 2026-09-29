// Response shaping for tm1_rest_read / tm1_rest_write.
//
// The response guard in ../with-annotations.ts refuses an oversized result
// outright (it can only re-trim the page envelope, which a raw OData body is
// not), so these tools cut their own payload to a character budget first.
// A value[] collection — or, for an entity, its largest array property, e.g.
// the Elements of `Hierarchies('H')?$expand=Elements` — is trimmed to the
// longest item prefix that fits, and stays valid JSON; only a single object
// too big even without its arrays falls back to a plain string cut.
import {
  DEFAULT_MAX_RESPONSE_CHARS,
  loadServerSettings,
} from "../../config.js";
import {
  MASK,
  maskCode,
  maskSecretValues,
  maskSecretsDeep,
} from "../../lib/mask-secrets.js";
import type { RestBody } from "../../tm1-client/services/rest-service.js";

export interface ShapedBody {
  truncated: boolean;
  /** JSON body with @odata annotations removed and secrets masked. */
  data?: unknown;
  /** Non-JSON body, or the cut serialization of a JSON body too big to trim. */
  text?: string;
  /** `@odata.count`, when the caller asked for `$count=true`. */
  count?: number;
  /** Items kept vs received in the trimmed array (`truncatedAt`). */
  kept?: number;
  total?: number;
  truncatedAt?: string;
  /** Size of the full shaped body when it had to be cut. */
  totalChars?: number;
}

// The limit the response guard enforces: TM1_MAX_RESPONSE_CHARS, read from
// the process env the same way src/index.ts reads it for withAnnotations. A
// per-connection .env cannot change it, so TM1Config.maxResponseChars is not
// the value to use. The env was validated at startup; the fallback only
// covers an embedder that never went through it.
export function responseLimit(env: NodeJS.ProcessEnv = process.env): number {
  try {
    return loadServerSettings(env).maxResponseChars;
  } catch {
    return DEFAULT_MAX_RESPONSE_CHARS;
  }
}

/** Room for the result keys around `data` (truncated, kept, total, …). */
export const ENVELOPE_CHARS = 500;

/**
 * The character budget for `data`: what the caller asked for, capped so the
 * whole result — `reserve` characters of envelope included — stays under
 * the response guard's limit. Over the limit the guard would refuse the
 * result outright instead of letting shapeBody trim it.
 */
export function dataBudget(
  requested: number,
  reserve: number,
  limit: number = responseLimit(),
): number {
  return Math.max(1, Math.min(requested, limit - reserve));
}

// `@odata.context`, `@odata.etag`, and property annotations such as
// `Process@odata.bind` / `Name@odata.type`. Noise to a model, and never data.
function isAnnotation(key: string): boolean {
  return key.startsWith("@") || key.toLowerCase().includes("@odata.");
}

function stripAnnotations(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripAnnotations);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (!isAnnotation(k)) out[k] = stripAnnotations(child);
    }
    return out;
  }
  return v;
}

// maskSecretsDeep is keyed by property name, so it cannot see an ODBCOpen
// password inside TI code: `GET Processes('P')` would hand out what
// tm1_get_process masks. TI code lives in the *Procedure properties.
function maskProcedures(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskProcedures);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        typeof child === "string" && /procedure$/i.test(k)
          ? maskCode(child)
          : maskProcedures(child);
    }
    return out;
  }
  return v;
}

export interface ShapeOptions {
  /**
   * The path addresses TI code directly (`Processes('P')/PrologProcedure`,
   * with or without `/$value`): the code then arrives as the primitive
   * `value` of the JSON body, or as the whole text body, where no
   * *Procedure key marks it. Set by planRead from the path.
   */
  code?: boolean;
  /**
   * The path names a secret property (`Processes('P')/DataSource/password`,
   * with or without `/$value`): a primitive `value` or the whole text body
   * IS the secret, and is replaced by the mask outright. Set by planRead.
   */
  secret?: boolean;
}

// A primitive body, or the primitive `value` of `{ value: … }`. An array or
// object value is a collection or entity, and maskSecretsDeep covers it.
function maskBareValue(data: unknown): unknown {
  if (data === null || typeof data !== "object") return MASK;
  if (Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  if ("value" in obj && (obj.value === null || typeof obj.value !== "object")) {
    return { ...obj, value: MASK };
  }
  return data;
}

/** Strip annotations and mask secrets in a parsed JSON body. */
export function cleanJson(json: unknown, opts: ShapeOptions = {}): unknown {
  const data = maskProcedures(maskSecretsDeep(stripAnnotations(json)));
  if (opts.secret) return maskBareValue(data);
  if (!opts.code) return data;
  if (typeof data === "string") return maskCode(data);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.value === "string")
      return { ...obj, value: maskCode(obj.value) };
  }
  return data;
}

const size = (v: unknown): number => JSON.stringify(v).length;

// The array worth trimming: the body itself, its `value`, or else its largest
// top-level array property.
function trimTarget(
  data: unknown,
): { key: string | undefined; items: unknown[] } | undefined {
  if (Array.isArray(data)) return { key: undefined, items: data };
  if (data === null || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.value)) return { key: "value", items: obj.value };
  let best: { key: string; items: unknown[]; chars: number } | undefined;
  for (const [key, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    const chars = size(v);
    if (best === undefined || chars > best.chars)
      best = { key, items: v, chars };
  }
  return best && { key: best.key, items: best.items };
}

function withItems(
  data: unknown,
  key: string | undefined,
  items: unknown[],
): unknown {
  return key === undefined
    ? items
    : { ...(data as Record<string, unknown>), [key]: items };
}

// Measured as it ships: inside the JSON payload every quote, backslash and
// line break is escaped, so a CRLF log can be ~1.5x its own length.
function cutText(text: string, maxChars: number): ShapedBody {
  if (size(text) <= maxChars) return { truncated: false, text };
  let lo = 0;
  let hi = Math.min(text.length, maxChars);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(text.slice(0, mid)) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return { truncated: true, text: text.slice(0, lo), totalChars: text.length };
}

/** Shape a response body to fit `maxChars` characters of JSON. */
export function shapeBody(
  body: RestBody,
  maxChars: number,
  opts: ShapeOptions = {},
): ShapedBody {
  if (body.kind === "empty") return { truncated: false };
  if (body.kind === "text") {
    if (opts.secret) return { truncated: false, text: MASK };
    const text = maskSecretValues(body.text);
    return cutText(opts.code ? maskCode(text) : text, maxChars);
  }

  const rawCount =
    body.json !== null && typeof body.json === "object"
      ? (body.json as Record<string, unknown>)["@odata.count"]
      : undefined;
  const count = typeof rawCount === "number" ? { count: rawCount } : {};
  const data = cleanJson(body.json, opts);
  const chars = size(data);
  if (chars <= maxChars) return { truncated: false, data, ...count };

  const target = trimTarget(data);
  if (target !== undefined && target.items.length > 0) {
    const { key, items } = target;
    // Largest n in [0, items.length) whose serialization fits.
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(withItems(data, key, items.slice(0, mid))) <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0) {
      return {
        truncated: true,
        data: withItems(data, key, items.slice(0, lo)),
        ...count,
        kept: lo,
        total: items.length,
        ...(key === undefined ? {} : { truncatedAt: key }),
        totalChars: chars,
      };
    }
  }
  return { ...cutText(JSON.stringify(data), maxChars), ...count };
}
