// Server domain service. Owns server-level read endpoints — configuration,
// message log, transaction log, error-log files. Stateless wrappers; nothing
// here mutates server state.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { ErrorLogFile, ServerInfo } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { odataKey } from "./odata-page.js";

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
