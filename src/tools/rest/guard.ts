// Path guard for tm1_rest_read / tm1_rest_write. Pure: no I/O, no client.
//
// The two generic REST tools must not become a way around the tools that are
// kept for their safety nets (tm1_upsert_process's preflight/backup/rollback,
// tm1_execute_process's never-retry heartbeat, tm1_set_cube_rules's check
// loop, tm1_write_cells's coordinate validation, …). Every request is
// therefore normalized and classified here before anything is sent; a refusal
// is a TM1Error whose hint names the tool to use instead.
//
// Matching works on a DECODED, lowercased, tokenized form of the path, never
// on the raw string, so `%27`, `PROCESSES`, a namespace-qualified action
// (`ibm.tm1.api.v1.ExecuteWithReturn`) or a blocked segment further down the
// path (`Chores('c')/Tasks(0)/Process`) all classify the same as the plain
// spelling. The RAW path is what gets sent, and TM1 decodes it exactly once,
// so the guard classifies the once-decoded form too. Decoding more often is
// NOT stricter: `%2527` would become a quote for the guard but stay the
// literal text `%27` for TM1, moving where quoted keys start and end, and a
// blocked segment could hide inside what the guard took for one key. A path
// that still holds an escape after one decode is refused instead.
//
// See docs/TOOL-CONSOLIDATION.md, "tm1_rest_read / tm1_rest_write".
import { isSecretName } from "../../lib/mask-secrets.js";
import { tm1NameEquals } from "../../lib/tm1-name.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";

export type WriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";
export type RestMethod = "GET" | WriteMethod;

/** One path segment, e.g. `Elements('a/b')` or `tm1.Compile`. */
export interface Segment {
  /** Lowercased, trimmed name before any `(`, e.g. `elements`, `tm1.compile`. */
  name: string;
  /** Last dotted component of `name`: the operation name without namespace. */
  op: string;
  /** Decoded key: quotes stripped, `''` unescaped. Numeric keys stay strings. */
  key?: string;
}

export interface ParsedPath {
  /** What gets sent, relative to /api/v1/ (raw, leading `/` dropped). */
  send: string;
  segments: Segment[];
  /** Decoded query string without the `?`, "" when there is none. */
  query: string;
}

export interface RestPlan {
  method: RestMethod;
  /** Path relative to /api/v1/, safe to hand to RestService. */
  path: string;
  body?: unknown;
  /** Set when the call needs `confirm` equal to this value. */
  confirmTarget?: string;
  /** The response may be bare TI code: mask it as code (see ./shape.ts). */
  maskCode?: boolean;
  /**
   * The path names a secret property (`DataSource/password`): the response
   * is the bare secret, with no secret-named key around it (see ./shape.ts).
   */
  maskSecret?: boolean;
}

function invalid(message: string, hint: string): TM1Error {
  return new TM1Error({ code: TM1ErrorCode.VALIDATION_ERROR, message, hint });
}

function refuse(message: string, hint: string): TM1Error {
  return new TM1Error({
    code: TM1ErrorCode.UNSUPPORTED_OPERATION,
    message: `${message} Nothing was sent.`,
    hint,
  });
}

// Strict: a `%` that starts no valid escape is refused, since TM1 would
// reject it too and the caller should send `%25`.
function decodeOnce(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw invalid(
      "Path has a malformed percent-escape.",
      "Encode a literal '%' as %25.",
    );
  }
}

// After one decode the path must hold no escape: TM1 would take `%27` as
// three literal characters where a second decode sees a quote (see the header),
// and the URL layer resolves `%2e%2e` as `..`. Only the path: in the query a
// once-decoded `%41` is plain filter text to TM1 and to the checks here alike.
function decodePath(raw: string): string {
  const path = decodeOnce(raw);
  if (/%[0-9a-f]{2}/i.test(path)) {
    throw invalid(
      "Path is percent-encoded more than once.",
      "Send the path encoded once (or not at all); a literal '%' in a name is %25.",
    );
  }
  return path;
}

// Split on `/` outside quotes and parentheses: `Elements('a/b')` is one
// segment. `''` inside a quoted key toggles out and straight back in, which
// is exactly what splitting needs.
function splitSegments(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  for (const ch of path) {
    if (ch === "'") inQuote = !inQuote;
    else if (!inQuote && ch === "(") depth++;
    else if (!inQuote && ch === ")") depth--;
    if (depth < 0) break;
    if (ch === "/" && !inQuote && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (inQuote || depth !== 0) {
    throw invalid(
      "Path has an unbalanced quote or parenthesis.",
      "Quote keys as Cubes('Name'); double a quote inside a name ('O''Brien'); encode ? or # in a name as %3F / %23.",
    );
  }
  out.push(cur);
  return out;
}

function unquoteKey(raw: string): string {
  const m = /^'([\s\S]*)'$/.exec(raw);
  return m ? m[1]!.replace(/''/g, "'") : raw;
}

function parseSegment(raw: string): Segment {
  const seg = raw.trim();
  if (seg === "" || seg === ".") {
    throw invalid(
      "Path has an empty or '.' segment.",
      "Remove doubled slashes and './' from the path.",
    );
  }
  const m = /^([^()']*)\(([\s\S]*)\)$/.exec(seg);
  if (m === null && /[()']/.test(seg)) {
    throw invalid(
      `Path segment "${seg}" is malformed.`,
      "A segment is Name, Name('key') or namespace.Action.",
    );
  }
  const name = (m ? m[1]! : seg).trim().toLowerCase();
  // Exact-name checks (cellsets, $batch, rules, …) are only as good as the
  // alphabet: no punctuation or lookalike letters in a segment name.
  if (!/^[a-z0-9_.$]+$/.test(name)) {
    throw invalid(
      `Path segment name "${name}" has characters no TM1 entity set or action uses.`,
      "Segment names are ASCII letters, digits, '_', '.' and '$'; object names go in keys: Cubes('My Cube').",
    );
  }
  const op = name.slice(name.lastIndexOf(".") + 1);
  return m ? { name, op, key: unquoteKey(m[2]!.trim()) } : { name, op };
}

/**
 * Normalize and tokenize a caller-supplied path. Throws VALIDATION_ERROR for
 * anything that is not a plain relative OData path.
 */
export function parsePath(raw: string): ParsedPath {
  let send = raw.trim();
  if (send === "") {
    throw invalid("path is empty.", "Pass a path such as Cubes?$select=Name.");
  }
  // A raw `#` would start a URL fragment and silently cut the request short.
  if (send.includes("#")) {
    throw invalid("Path contains '#'.", "Encode a '#' inside a name as %23.");
  }
  if (send.startsWith("/")) send = send.slice(1);

  const qAt = send.indexOf("?");
  const rawPath = qAt === -1 ? send : send.slice(0, qAt);
  const rawQuery = qAt === -1 ? "" : send.slice(qAt + 1);
  const path = decodePath(rawPath);
  const query = decodeOnce(rawQuery);
  const whole = `${path}?${query}`;

  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) {
    throw invalid(
      "path must be relative to /api/v1/, not an absolute URL.",
      "Pass e.g. Dimensions('Region')/Hierarchies('Region')/Elements?$top=50.",
    );
  }
  if (/^api\//i.test(path)) {
    throw invalid(
      "path must be relative to /api/v1/; drop the leading api/v1/.",
      "Pass e.g. Cubes?$select=Name, not /api/v1/Cubes.",
    );
  }
  if (/[\p{Cc}\p{Cf}]/u.test(whole)) {
    throw invalid(
      "Path contains control or invisible formatting characters.",
      "Remove them; TM1 object names do not contain any.",
    );
  }
  if (whole.includes("\\")) {
    throw invalid("Path contains a backslash.", "Use '/' between segments.");
  }
  // The URL parser resolves `..` (also `%2e%2e`) even inside a quoted key, so
  // a traversal could leave the path this guard classified.
  if (path.includes("..")) {
    throw invalid(
      "Path contains '..'.",
      "Address the object directly; relative segments are not allowed.",
    );
  }

  const parts = splitSegments(path.endsWith("/") ? path.slice(0, -1) : path);
  return { send, segments: parts.map(parseSegment), query };
}

// ── Classification ──────────────────────────────────────────────────────────

const has = (p: ParsedPath, pred: (s: Segment) => boolean): boolean =>
  p.segments.some(pred);

function hintForExecute(p: ParsedPath, op: string): string {
  if (
    has(p, (s) => s.name.startsWith("process")) ||
    op.startsWith("executeprocess")
  ) {
    return "Run processes with tm1_execute_process (heartbeat, timeout, error-log pickup, never re-sent).";
  }
  if (has(p, (s) => s.name.startsWith("chore"))) {
    return "Run chores with tm1_execute_chore.";
  }
  if (has(p, (s) => s.name.endsWith("views"))) {
    return "Read views with tm1_get_view.";
  }
  if (op.startsWith("executemdx")) {
    return "Run MDX with tm1_execute_mdx.";
  }
  return "Use tm1_execute_process, tm1_execute_chore, tm1_execute_mdx or tm1_get_view.";
}

// Query options (top-level or nested in $expand) and parameter aliases whose
// value is an expression evaluated over property values on the server.
const EXPR_OPTION_RE =
  /(?:^|[&;(])\s*(\$(?:filter|orderby|search|apply|compute)|@[a-z_]\w*)\s*=/gi;
const EXPR_SEGMENTS = new Set(["$filter", "$search", "$apply", "$compute"]);

// The option value from `from` up to its `&`, `;` or closing `)`,
// quote- and paren-aware.
function expressionAt(query: string, from: number): string {
  let inQuote = false;
  let depth = 0;
  let i = from;
  for (; i < query.length; i++) {
    const ch = query[i]!;
    if (ch === "'") inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) break;
    else if ((ch === "&" || ch === ";") && depth === 0) break;
  }
  return query.slice(from, i);
}

// A property named in an expression, outside string literals, that holds a
// secret (`DataSource/password`) or TI code (`PrologProcedure`, where an
// ODBCOpen password sits). Masking only hides the value in the response; a
// `$filter=startswith(DataSource/password,'a')` still lets TM1 compare the
// real value, and which rows come back gives it away character by character.
function secretInExpression(p: ParsedPath): string | undefined {
  const exprs = [...p.query.matchAll(EXPR_OPTION_RE)].map((m) =>
    expressionAt(p.query, m.index + m[0].length),
  );
  for (const s of p.segments) {
    if (EXPR_SEGMENTS.has(s.name) && s.key !== undefined) exprs.push(s.key);
  }
  for (const expr of exprs) {
    const bare = expr.replace(/'(?:[^']|'')*'/g, "''");
    const hit = bare
      .match(/[a-z_]\w*/gi)
      ?.find((t) => isSecretName(t) || /procedure$/i.test(t));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Refusals shared by both tools: operations a kept tool owns. */
function checkShared(p: ParsedPath, write: boolean): void {
  // `$entity?$id=<path>` addresses whatever `$id` names, so every check
  // here and every masking flag would be looking at the wrong path.
  if (has(p, (s) => s.name === "$entity")) {
    throw refuse(
      "$entity is not allowed: its $id target would pass unchecked.",
      "Address the object by its own path, e.g. Processes('P')/DataSource.",
    );
  }
  if (has(p, (s) => s.name === "$batch")) {
    throw refuse(
      "$batch is not allowed: its inner requests would pass unchecked.",
      "Send the requests one at a time; delete many elements with tm1_delete_elements.",
    );
  }
  const secret = secretInExpression(p);
  if (secret !== undefined) {
    throw refuse(
      `${secret} is used in a query expression; comparing against a secret or TI code would reveal it through which rows come back.`,
      "Filter and sort on other properties; search TI code with tm1_search_code (secrets masked).",
    );
  }
  const exec = p.segments.find((s) => s.op.startsWith("execute"));
  if (exec) {
    throw refuse(
      `${exec.name} runs server-side code or queries.`,
      hintForExecute(p, exec.op),
    );
  }
  if (has(p, (s) => s.name === "cellsets")) {
    throw refuse(
      "Cellsets are not reachable through the REST tools.",
      write
        ? "Write cells with tm1_write_cells."
        : "Read cells with tm1_execute_mdx or tm1_get_view.",
    );
  }
  if (has(p, (s) => s.op === "update" || s.op === "updatecells")) {
    throw refuse(
      "Cell updates are not allowed here.",
      "Write cells with tm1_write_cells (coordinate validation).",
    );
  }
  if (has(p, (s) => s.op.startsWith("savedata"))) {
    throw refuse("SaveData is not allowed here.", "Use tm1_save_data.");
  }
  if (has(p, (s) => s.op.startsWith("clear"))) {
    throw refuse("Clearing a cube is not allowed here.", "Use tm1_clear_cube.");
  }
}

function isCompile(p: ParsedPath): boolean {
  const [a, b] = p.segments;
  return (
    p.segments.length === 2 &&
    a!.name === "processes" &&
    a!.key !== undefined &&
    b!.op === "compile"
  );
}

const FILE_SETS = new Set(["contents", "files", "blobs"]);

// A segment such as `password` in `Processes('P')/DataSource/password` or
// `ActiveConfiguration/Access/LDAP/Password/$value`. maskSecretsDeep works by
// key name, and a primitive-property read returns `{ value: … }` or a bare
// text body: the secret-named key is in the path, not the response.
const namesSecret = (p: ParsedPath): boolean =>
  has(p, (s) => isSecretName(s.op));

function withMasks(plan: RestPlan, p: ParsedPath, code: boolean): RestPlan {
  return {
    ...plan,
    ...(code ? { maskCode: true } : {}),
    ...(namesSecret(p) ? { maskSecret: true } : {}),
  };
}

/**
 * Plan a tm1_rest_read call. GET for everything, except the one read-only
 * POST `Processes('P')/tm1.Compile`. Any other operation segment is refused:
 * GET cannot invoke an action, and a namespaced segment on the read tool is
 * almost always an attempt to.
 */
export function planRead(rawPath: string): RestPlan {
  const p = parsePath(rawPath);
  checkShared(p, false);
  if (isCompile(p)) {
    if (p.query !== "") {
      throw invalid(
        "tm1.Compile takes no query options.",
        "Pass exactly Processes('Name')/tm1.Compile.",
      );
    }
    return { method: "POST", path: p.send };
  }
  // `Processes('P')/PrologProcedure[/$value]` returns the code with no
  // *Procedure key around it. Any process path is flagged: masking code
  // that is not there changes nothing.
  const code = has(
    p,
    (s) => s.name.startsWith("process") || s.name.endsWith("procedure"),
  );
  const action = p.segments.find((s) => s.name.includes("."));
  if (action) {
    throw refuse(
      `tm1_rest_read only reads; ${action.name} is an action.`,
      "Use tm1_rest_write for actions (the only read-only one here is Processes('P')/tm1.Compile).",
    );
  }
  const last = p.segments[p.segments.length - 1]!;
  if (last.name === "content" && has(p, (s) => FILE_SETS.has(s.name))) {
    throw refuse(
      "File content is binary-safe only through the file tool.",
      "Read file content with tm1_files_read (op: get).",
    );
  }
  return withMasks({ method: "GET", path: p.send }, p, code);
}

// A body key named Rules (also `Rules@odata.bind` and friends), at any depth.
function bodyHasRules(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(bodyHasRules);
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).some(
      ([k, child]) =>
        k.split("@")[0]!.trim().toLowerCase() === "rules" ||
        bodyHasRules(child),
    );
  }
  return false;
}

// A process definition deep-inserted elsewhere, e.g. an inline Process with
// PrologProcedure inside a chore Task: any key ending in Procedure, or a
// Process/Processes key holding an object or array. `Process@odata.bind`
// (a reference, not a definition) is fine.
function bodyHasProcess(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(bodyHasProcess);
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).some(([k, child]) => {
      const base = k.split("@")[0]!.trim().toLowerCase();
      if (base.endsWith("procedure")) return true;
      if (
        !k.includes("@") &&
        (base === "process" || base === "processes") &&
        child !== null &&
        typeof child === "object"
      ) {
        return true;
      }
      return bodyHasProcess(child);
    });
  }
  return false;
}

// `DELETE Users('u')/Groups?$id=Groups('g')` removes g, not u: on a
// reference delete (last segment `$ref`, or a keyless navigation collection)
// the target is the last key of `$id`. On an entity DELETE TM1 deletes the
// object in the path whatever `$id` says, so `$id` is refused there rather
// than let it pick the confirm target.
function confirmTargetOf(p: ParsedPath): string | undefined {
  const id = /(?:^|&)\s*\$id\s*=([^&]*)/i.exec(p.query)?.[1];
  const last = p.segments[p.segments.length - 1]!;
  const isRef =
    last.name === "$ref" || (last.key === undefined && p.segments.length > 1);
  if (id !== undefined && !isRef) {
    throw invalid(
      "$id only applies to a reference delete; this request targets the object in the path.",
      "Drop $id, or delete the reference: Users('u')/Groups/$ref?$id=Groups('g').",
    );
  }
  if (id !== undefined) {
    const idKey = [...id.matchAll(/\(\s*('(?:[^']|'')*'|[^()]*)\s*\)/g)]
      .map((m) => unquoteKey(m[1]!.trim()))
      .pop();
    if (idKey !== undefined) return idKey;
  }
  return p.segments
    .map((s) => s.key)
    .filter((k) => k !== undefined)
    .pop();
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw invalid(
      "body is a string that is not valid JSON.",
      'Pass body as a JSON object, e.g. { "Active": true }.',
    );
  }
}

/**
 * Plan a tm1_rest_write call: refuse what a kept tool owns, and work out the
 * confirm target for DELETE and cancel/close actions.
 */
export function planWrite(
  method: WriteMethod,
  rawPath: string,
  rawBody?: unknown,
): RestPlan {
  const p = parsePath(rawPath);
  checkShared(p, true);
  const body = parseBody(rawBody);

  if (has(p, (s) => s.name.startsWith("process"))) {
    if (isCompile(p)) {
      throw refuse(
        "tm1.Compile is a read.",
        "Compile with tm1_rest_read (path Processes('Name')/tm1.Compile).",
      );
    }
    const deletesProcess =
      method === "DELETE" &&
      p.segments.length === 1 &&
      p.segments[0]!.name === "processes" &&
      p.segments[0]!.key !== undefined;
    if (!deletesProcess) {
      throw refuse(
        "Process writes are not allowed here.",
        "Create or change processes with tm1_upsert_process (preflight, backup, rollback). Only DELETE Processes('Name') is allowed here.",
      );
    }
  }
  if (has(p, (s) => s.name === "rules")) {
    throw refuse(
      "Rule writes are not allowed here.",
      "Change cube rules with tm1_set_cube_rules.",
    );
  }
  if (method !== "DELETE" && bodyHasRules(body)) {
    throw refuse(
      "The body sets Rules.",
      "Create the cube without Rules, then set them with tm1_set_cube_rules.",
    );
  }
  if (method !== "DELETE" && bodyHasProcess(body)) {
    throw refuse(
      "The body defines a process.",
      "Create or change processes with tm1_upsert_process (preflight, backup, rollback); reference one here with Process@odata.bind.",
    );
  }
  if (has(p, (s) => FILE_SETS.has(s.name))) {
    throw refuse(
      "File writes are not allowed here.",
      "Upload or delete files with tm1_files_write.",
    );
  }
  if (method === "DELETE" && body !== undefined) {
    throw invalid("DELETE takes no body.", "Drop body.");
  }
  // TM1 11.8 accepts this DELETE and leaves the dimension with no hierarchy at
  // all (measured in tests/live/rest.live.test.ts).
  const [dim, hier] = p.segments;
  if (
    method === "DELETE" &&
    p.segments.length === 2 &&
    dim!.name === "dimensions" &&
    hier!.name === "hierarchies" &&
    dim!.key !== undefined &&
    hier!.key !== undefined &&
    tm1NameEquals(dim!.key, hier!.key)
  ) {
    throw refuse(
      `Hierarchy '${hier!.key}' is the default hierarchy of '${dim!.key}'; deleting it leaves the dimension without one.`,
      `Delete the whole dimension instead: DELETE Dimensions('${dim!.key}').`,
    );
  }

  const last = p.segments[p.segments.length - 1]!;
  const needsConfirm =
    method === "DELETE" || last.op.startsWith("cancel") || last.op === "close";
  if (!needsConfirm) {
    return withMasks(
      body === undefined
        ? { method, path: p.send }
        : { method, path: p.send, body },
      p,
      false,
    );
  }
  const target = confirmTargetOf(p);
  if (target === undefined) {
    throw invalid(
      `${method === "DELETE" ? "DELETE" : last.name} needs a keyed target.`,
      "Address one object, e.g. DELETE Cubes('Name')/Views('View').",
    );
  }
  return withMasks(
    body === undefined
      ? { method, path: p.send, confirmTarget: target }
      : { method, path: p.send, body, confirmTarget: target },
    p,
    false,
  );
}
