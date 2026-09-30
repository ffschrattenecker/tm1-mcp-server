// Server domain service. Owns server-level read endpoints — configuration,
// message log, transaction log, error-log files. Stateless wrappers; nothing
// here mutates server state.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  CellValue,
  ErrorLogFile,
  ServerInfo,
  TransactionLogEntry,
} from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { rethrowIfSystemicOrDenied } from "./fallback.js";
import { escapeOdataLiteral, odataKey } from "./odata-page.js";

// TM1 references the per-run TI error file inside the free-text message, either
// wrapped in angle brackets (e.g. German `Fehlerdatei: <…log>`) or bare
// (`see TM1ProcessError_…log`). Both regexes are linear (no nested quantifiers,
// delimiter excluded from the class) — no ReDoS guard needed for these literals.
const ANGLE_WRAPPED_LOG = /<([^<>\s]+\.log)>/i;
const BARE_PROCESS_ERROR_LOG = /TM1ProcessError_[^\s<>'"()]+\.log/i;

/**
 * Pull the TM1 error log filename out of a message-log entry's free text, so it
 * can be fed straight into `tm1_get_error_log_content(filename=…)`. Returns the
 * exact filename (no surrounding brackets) or undefined when none is mentioned.
 */
export function extractErrorFile(message: string): string | undefined {
  const angle = message.match(ANGLE_WRAPPED_LOG);
  if (angle) return angle[1];
  const bare = message.match(BARE_PROCESS_ERROR_LOG);
  return bare ? bare[0] : undefined;
}

// The TransactionLogEntries endpoint scans the whole log server-side and is
// slow; without log-read rights it can hang until the global request timeout.
// Before the real (orderby + filtered) query we fire a bare `$top=1` probe —
// NO $orderby, NO $filter, so TM1 can stop after the first row and the result
// is at most one entry — bounded by a short timeout to fail fast.
const TXLOG_PROBE_TIMEOUT_MS = 8000;
// Per-window query timeout. Each windowed/bounded query runs once (no retry),
// so a timeout means the range is too large/dense — not a transient blip.
const TXLOG_QUERY_TIMEOUT_MS = 20000;

/**
 * Normalize a user timestamp into an OData v4 DateTimeOffset literal for a
 * TM1 $filter. TM1 rejects a bare `2026-06-08T00:00:00` ("Syntax error … near
 * -06") — the value MUST carry a timezone. Verified against TM1 11.8: only the
 * `Z`-suffixed (or ±hh:mm-offset) form parses. Date-only input expands to
 * start-of-day UTC; a zoneless datetime gets a `Z`; an already-zoned value is
 * left untouched.
 */
export function toOdataDateTime(input: string): string {
  let t = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T00:00:00`;
  if (!/[zZ]$/.test(t) && !/[+-]\d{2}:\d{2}$/.test(t)) t = `${t}Z`;
  // Validate before it reaches a $filter. Appending "Z" to whatever arrived
  // turned "yesterday" into "yesterdayZ" and shipped it to TM1, which answers
  // with an opaque OData parse error naming neither the parameter nor the bad
  // value. Rejecting here names both.
  //
  // Shape check FIRST, then Date.parse — Date.parse alone is too permissive to
  // be a gate. It accepts V8's legacy formats, so "08/06/2026" parses happily
  // as 6 August; a caller who meant 8 June would silently get a different day
  // and a plausible-looking, wrong result. Ambiguous input must fail loudly.
  const ISO_DATETIME =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  if (!ISO_DATETIME.test(t) || Number.isNaN(Date.parse(t))) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message:
        `Not a usable timestamp: '${input}'. Expected ISO-8601 — ` +
        `'2026-06-08', '2026-06-08T14:30:00', or with a zone ` +
        `('...Z' / '...+02:00'). A value without a zone is read as UTC.`,
    });
  }
  return t;
}

// enc stays plain — it also wraps whole $filter/$orderby clauses below, where
// the inner string literals are already single-quote-escaped via escapeOdataLiteral().
const enc = encodeURIComponent;

export class ServerService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Fetch TM1 server configuration. Merges /Configuration and
   * /ActiveConfiguration; tolerates ActiveConfiguration being absent on
   * older builds.
   */
  async getInfo(): Promise<ServerInfo> {
    const cfg = await this.http.request<Record<string, unknown>>(
      "GET",
      "/api/v1/Configuration",
    );
    let active: Record<string, unknown> = {};
    try {
      active = await this.http.request<Record<string, unknown>>(
        "GET",
        "/api/v1/ActiveConfiguration",
      );
    } catch {
      // Some TM1 versions don't expose ActiveConfiguration — ignore.
    }
    const merged: Record<string, unknown> = { ...cfg, ...active };
    delete merged["@odata.context"];
    // v12 (Planning Analytics Engine) omits ProductVersion from the
    // Configuration object body; it is exposed only as a scalar sub-resource.
    // Fall back to it when the inline field is absent (v11 has it inline, so
    // this extra request never fires there).
    let productVersion = String(merged.ProductVersion ?? "");
    if (!productVersion) {
      try {
        const pv = await this.http.request<{ value?: unknown }>(
          "GET",
          "/api/v1/Configuration/ProductVersion",
        );
        if (typeof pv.value === "string") {
          productVersion = pv.value;
        }
      } catch {
        // Scalar sub-resource unavailable — leave version empty.
      }
    }
    return {
      serverName: String(merged.ServerName ?? ""),
      productVersion,
      productEdition:
        merged.ProductEdition !== undefined
          ? String(merged.ProductEdition)
          : undefined,
      adminHost:
        merged.AdminHost !== undefined ? String(merged.AdminHost) : undefined,
      dataDirectory:
        merged.DataBaseDirectory !== undefined
          ? String(merged.DataBaseDirectory)
          : undefined,
      timeZoneId:
        merged.TimeZoneID !== undefined ? String(merged.TimeZoneID) : undefined,
      integratedSecurityMode:
        merged.IntegratedSecurityMode !== undefined
          ? String(merged.IntegratedSecurityMode)
          : undefined,
      extra: merged,
    };
  }

  /**
   * Single bounded TransactionLogEntries query. Runs once (retry disabled) under
   * a dedicated timeout: the endpoint is deterministically slow, so a timeout
   * means "range too large", not a transient blip. Our own timeout (the
   * controller abort) and other non-systemic failures become an actionable
   * "narrow the range" error; systemic transport/auth failures propagate
   * unmasked and permission denials surface as-is.
   */
  private async queryTransactionLog(q: {
    top: number;
    cubeName?: string | undefined;
    user?: string | undefined;
    since?: string | undefined;
    until?: string | undefined;
  }): Promise<TransactionLogEntry[]> {
    const filters: string[] = [];
    if (q.cubeName) filters.push(`Cube eq '${escapeOdataLiteral(q.cubeName)}'`);
    if (q.user) filters.push(`User eq '${escapeOdataLiteral(q.user)}'`);
    if (q.since) filters.push(`TimeStamp ge ${toOdataDateTime(q.since)}`);
    if (q.until) filters.push(`TimeStamp le ${toOdataDateTime(q.until)}`);
    const qs: string[] = [`$top=${q.top}`, `$orderby=TimeStamp desc`];
    if (filters.length > 0) qs.push(`$filter=${enc(filters.join(" and "))}`);
    const path = `/api/v1/TransactionLogEntries?${qs.join("&")}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TXLOG_QUERY_TIMEOUT_MS);
    try {
      const response = await this.http.request<{
        value: Array<{
          TimeStamp?: string;
          User?: string;
          Cube?: string;
          Tuple?: string[];
          OldValue?: CellValue;
          NewValue?: CellValue;
        }>;
      }>("GET", path, undefined, { signal: controller.signal, retry: false });
      return response.value.map((e) => ({
        timestamp: e.TimeStamp ?? "",
        user: e.User ?? "",
        cubeName: e.Cube ?? "",
        elements: e.Tuple ?? [],
        oldValue: e.OldValue ?? null,
        newValue: e.NewValue ?? null,
      }));
    } catch (err) {
      // Our own dedicated timeout aborts via the controller and surfaces as a
      // raw (non-TM1) abort — that IS the "range too large" signal. For every
      // other error, systemic transport/auth failures (CONNECTION_FAILED,
      // AUTH_FAILED, LOCK_TIMEOUT) and unexpected non-TM1 throws must propagate
      // unmasked, and a permission denial stays actionable; only then do we fall
      // through and treat the failure as an actionable "narrow the range" error.
      if (!controller.signal.aborted) {
        rethrowIfSystemicOrDenied(err);
      }
      throw new TM1Error({
        code: TM1ErrorCode.TM1_ERROR,
        message: `Transaction log query exceeded ${TXLOG_QUERY_TIMEOUT_MS / 1000}s — the time range is too large or dense.`,
        endpoint: path,
        details: err instanceof Error ? err.message : String(err),
        hint: "Bound the scan with a narrower since/until (from-to) range, or add cubeName/user.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cheap reachability/permission probe for the transaction log. A bare
   * `$top=1` (no $orderby/$filter) returns at most one row so TM1 can short-
   * circuit; a dedicated short-timeout AbortController caps the wait. That
   * timeout (and other non-systemic failures) becomes an actionable TM1_ERROR;
   * permission denials surface as-is and systemic transport/auth failures
   * (e.g. CONNECTION_FAILED) propagate unmasked.
   */
  private async probeTransactionLog(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TXLOG_PROBE_TIMEOUT_MS);
    try {
      await this.http.request<{ value: unknown[] }>(
        "GET",
        "/api/v1/TransactionLogEntries?$top=1",
        undefined,
        { signal: controller.signal },
      );
    } catch (err) {
      // Our own probe timeout aborts via the controller and yields the friendly
      // preflight message. For every other error, systemic transport/auth
      // failures (CONNECTION_FAILED, AUTH_FAILED, LOCK_TIMEOUT) and unexpected
      // non-TM1 throws must propagate unmasked, and a permission denial stays
      // actionable (fail fast); only then do we wrap as a TM1_ERROR preflight.
      if (!controller.signal.aborted) {
        rethrowIfSystemicOrDenied(err);
      }
      throw new TM1Error({
        code: TM1ErrorCode.TM1_ERROR,
        message: `Transaction log preflight failed (timeout ${TXLOG_PROBE_TIMEOUT_MS / 1000}s): the endpoint scans the whole log and may hang or be denied without log-read rights.`,
        endpoint: "/api/v1/TransactionLogEntries",
        details: err instanceof Error ? err.message : String(err),
        hint: "Narrow the query with `since`, `cubeName`, or `user`, or verify the account has transaction-log read rights.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * List TI process error log files.
   *
   * TM1 v11 OData exposes only `Filename` on this entity set (no LastUpdated /
   * $select / $orderby support). Sorting is filename-descending — filenames
   * embed a yyyymmddhhmmss timestamp, so lexical desc sort matches
   * chronological newest-first. Filters (processName, since, top) are applied
   * client-side.
   */
  async listErrorLogFiles(
    opts: {
      processName?: string | undefined;
      since?: string | undefined;
      top?: number | undefined;
    } = {},
  ): Promise<ErrorLogFile[]> {
    const top = opts.top ?? 50;
    const response = await this.http.request<{
      value: Array<{ Filename?: string }>;
    }>("GET", "/api/v1/ErrorLogFiles");
    let entries = response.value
      .map((e): ErrorLogFile => ({ filename: e.Filename ?? "" }))
      .filter((e) => e.filename);

    if (opts.processName) {
      const proc = opts.processName.toLowerCase();
      // TM1 v11+ pattern with session hash: TM1ProcessError_<ts>_<id>_<proc>_<hash>.log
      // TM1 pattern without hash:           TM1ProcessError_<ts>_<id>_<proc>.log
      // TM1 v12 pattern:                    ProcessLog_<ts>_<id>_<proc>.jsonl
      // Legacy/manual pattern:              <proc>_<ts>.log
      entries = entries.filter((e) => {
        const f = e.filename.toLowerCase();
        return (
          f === proc ||
          f.startsWith(`${proc}_`) ||
          f.endsWith(`_${proc}.log`) ||
          f.endsWith(`_${proc}.jsonl`) ||
          f.includes(`_${proc}_`)
        );
      });
    }
    if (opts.since) {
      const sinceCompact = opts.since.replace(/[^0-9]/g, "").slice(0, 14);
      if (sinceCompact.length >= 8) {
        entries = entries.filter((e) => {
          const m =
            e.filename.match(/(?:TM1ProcessError_|_)(\d{14})/) ??
            e.filename.match(/_(\d{8,14})\.log$/i);
          return m ? m[1]! >= sinceCompact.slice(0, m[1]!.length) : true;
        });
      }
    }
    entries.sort((a, b) =>
      a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0,
    );
    return entries.slice(0, top);
  }

  /**
   * Fetch the raw text content of a single TI error log file.
   * GET /api/v1/ErrorLogFiles('<filename>')/Content
   */
  async getErrorLogContent(filename: string): Promise<string> {
    const path = `/api/v1/ErrorLogFiles('${odataKey(filename)}')/Content`;
    return await this.http.requestRaw("GET", path);
  }
}
