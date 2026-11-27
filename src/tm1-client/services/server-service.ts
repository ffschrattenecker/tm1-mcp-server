// Server domain service. Owns server-level read endpoints — configuration and
// error-log files. Stateless wrappers; nothing here mutates server state.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  ActivityItem,
  CellValue,
  ErrorLogFile,
  MessageLogEntry,
  ServerInfo,
  SessionItem,
  TransactionLogEntry,
} from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";
import { rethrowIfSystemicOrDenied } from "./fallback.js";
import { escapeOdataLiteral, odataKey } from "./odata-page.js";
import { maskSecretValues } from "../../lib/mask-secrets.js";

export function normalizeLogTimestamp(raw: string, fieldName: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Invalid ${fieldName} timestamp "${raw}".`,
      hint: 'Use ISO 8601 format, e.g. "2026-11-27T00:00:00Z".',
    });
  }
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Parse TM1's ISO-8601 duration string (e.g. `"P0DT00H01M04S"`, `"PT5.2S"`)
 * into total seconds, rounded to 3 decimal places. Returns `undefined` when
 * the input is absent, empty, or unparseable.
 */
export function parseIsoDurationSeconds(
  raw: string | undefined,
): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      trimmed,
    );
  if (!m) return undefined;
  if (
    m[1] === undefined &&
    m[2] === undefined &&
    m[3] === undefined &&
    m[4] === undefined
  ) {
    return undefined;
  }
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const mins = m[3] ? Number(m[3]) : 0;
  const secs = m[4] ? Number(m[4]) : 0;
  const total = days * 86_400 + hours * 3_600 + mins * 60 + secs;
  return Number.isFinite(total) ? Math.round(total * 1000) / 1000 : undefined;
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
   * True when tm1s.cfg sets DisableSandboxing=T, false when it is set to F.
   * Read from /Configuration because every user may read it; /ActiveConfiguration
   * answers a non-admin with ObjectSecurityNoAdminRights. v12 has no such field
   * and yields undefined, which the client reads as "not disabled".
   * Never throws: a failed request or a non-boolean value yields undefined.
   * GET /api/v1/Configuration
   */
  async isSandboxingDisabled(): Promise<boolean | undefined> {
    try {
      const cfg = await this.http.request<{ DisableSandboxing?: unknown }>(
        "GET",
        "/api/v1/Configuration",
      );
      const value = cfg.DisableSandboxing;
      return typeof value === "boolean" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * List TI process error log files.
   *
   * The entity set exposes only `Filename`. Sorting is filename-descending —
   * filenames embed a yyyymmddhhmmss timestamp, so lexical desc sort matches
   * chronological newest-first. Both versions sort, filter and cap this set
   * server-side (measured 2026-10-04; a v12 test server held 23 000 files), so
   * the sort, a case-insensitive name prefilter for `processName` and, when
   * nothing else filters, `$top` go to TM1. The exact process-name match and
   * `since` stay client-side: the filename layouts differ by version.
   */
  async listErrorLogFiles(
    opts: {
      processName?: string | undefined;
      since?: string | undefined;
      top?: number | undefined;
    } = {},
  ): Promise<ErrorLogFile[]> {
    const top = opts.top ?? 50;
    let query = "?$orderby=Filename desc";
    if (opts.processName) {
      // Superset of every pattern matched below; narrowed client-side.
      query += `&$filter=contains(tolower(Filename),'${odataKey(opts.processName.toLowerCase())}')`;
    } else if (!opts.since) {
      query += `&$top=${top}`;
    }
    const response = await this.http.request<{
      value: Array<{ Filename?: string }>;
    }>("GET", `/api/v1/ErrorLogFiles${query}`);
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

  /**
   * Fetch live server activity (v11 Threads or v12 Jobs) and active Sessions.
   */
  async getActivitySnapshot(
    opts: { includeSessions?: boolean; request?: RequestOptions } = {},
  ): Promise<{
    version: 11 | 12;
    source: "Threads" | "Jobs";
    activities: ActivityItem[];
    sessions?: SessionItem[];
    sessionsError?: string;
  }> {
    const version = this.http.version;
    const includeSessions = opts.includeSessions !== false;

    const fetchActivities = async (): Promise<{
      source: "Threads" | "Jobs";
      activities: ActivityItem[];
    }> => {
      if (version === 12) {
        type RawJob = {
          ID: string | number;
          Description?: string;
          State?: string;
          ElapsedTime?: string;
          WaitTime?: string;
          WaitingOn?: Array<string | { ID?: string | number }>;
          Session?: {
            ID?: string | number;
            Context?: string;
            User?: { Name?: string } | null;
          } | null;
        };
        let jobsRes: { value?: RawJob[] };
        try {
          jobsRes = await this.http.request<{ value?: RawJob[] }>(
            "GET",
            "/api/v1/Jobs?$expand=Session($select=ID,Context,Active;$expand=User($select=Name,FriendlyName))",
            undefined,
            opts.request,
          );
        } catch (err) {
          rethrowIfSystemicOrDenied(err);
          jobsRes = await this.http.request<{ value?: RawJob[] }>(
            "GET",
            "/api/v1/Jobs",
            undefined,
            opts.request,
          );
        }
        const activities: ActivityItem[] = (jobsRes.value ?? []).map((j) => {
          const item: ActivityItem = {
            id: String(j.ID),
            kind: "job",
            user: j.Session?.User?.Name ?? null,
            state: j.State ?? "",
            operation: j.Description ?? "",
          };
          if (j.Session?.Context) item.context = j.Session.Context;
          if (j.ElapsedTime !== undefined) {
            item.elapsedTime = j.ElapsedTime;
            const sec = parseIsoDurationSeconds(j.ElapsedTime);
            if (sec !== undefined) item.elapsedSeconds = sec;
          }
          if (j.WaitTime !== undefined) {
            item.waitTime = j.WaitTime;
            const sec = parseIsoDurationSeconds(j.WaitTime);
            if (sec !== undefined) item.waitSeconds = sec;
          }
          if (Array.isArray(j.WaitingOn) && j.WaitingOn.length > 0) {
            item.waitingOn = j.WaitingOn.map((w) =>
              typeof w === "string" ? w : String(w.ID ?? ""),
            ).filter(Boolean);
          }
          if (j.Session?.ID !== undefined) {
            item.sessionId = String(j.Session.ID);
          }
          return item;
        });
        return { source: "Jobs", activities };
      }

      type RawThread = {
        ID: number | string;
        Name?: string;
        Type?: string;
        State?: string;
        Function?: string;
        ObjectType?: string;
        ObjectName?: string;
        Context?: string;
        Info?: string;
        ElapsedTime?: string;
        WaitTime?: string;
        RLocks?: number;
        IXLocks?: number;
        WLocks?: number;
      };
      const threadsRes = await this.http.request<{ value?: RawThread[] }>(
        "GET",
        "/api/v1/Threads",
        undefined,
        opts.request,
      );
      const activities: ActivityItem[] = (threadsRes.value ?? []).map((t) => {
        const item: ActivityItem = {
          id: String(t.ID),
          kind: "thread",
          user: t.Name && t.Name.length > 0 ? t.Name : null,
          state: t.State ?? "",
          operation: t.Function ?? "",
        };
        if (t.Context) item.context = t.Context;
        if (t.Type) item.threadType = t.Type;
        if (t.ObjectType) item.objectType = t.ObjectType;
        if (t.ObjectName) item.objectName = t.ObjectName;
        if (t.Info) item.info = t.Info;
        if (t.ElapsedTime !== undefined) {
          item.elapsedTime = t.ElapsedTime;
          const sec = parseIsoDurationSeconds(t.ElapsedTime);
          if (sec !== undefined) item.elapsedSeconds = sec;
        }
        if (t.WaitTime !== undefined) {
          item.waitTime = t.WaitTime;
          const sec = parseIsoDurationSeconds(t.WaitTime);
          if (sec !== undefined) item.waitSeconds = sec;
        }
        if (
          t.RLocks !== undefined ||
          t.IXLocks !== undefined ||
          t.WLocks !== undefined
        ) {
          item.locks = {
            read: t.RLocks ?? 0,
            intentWrite: t.IXLocks ?? 0,
            write: t.WLocks ?? 0,
          };
        }
        return item;
      });
      return { source: "Threads", activities };
    };

    const fetchSessions = async (): Promise<SessionItem[]> => {
      const res = await this.http.request<{
        value?: Array<{
          ID: number | string;
          Active?: boolean;
          Context?: string;
          User?: { Name?: string; FriendlyName?: string } | null;
        }>;
      }>(
        "GET",
        "/api/v1/Sessions?$select=ID,Context,Active&$expand=User($select=Name,FriendlyName)",
        undefined,
        opts.request,
      );
      return (res.value ?? []).map((s) => {
        const item: SessionItem = {
          id: String(s.ID),
          user: s.User?.Name ?? null,
        };
        if (s.User?.FriendlyName) item.friendlyName = s.User.FriendlyName;
        if (s.Active !== undefined) item.active = s.Active;
        if (s.Context) item.context = s.Context;
        return item;
      });
    };

    if (!includeSessions) {
      const act = await fetchActivities();
      return {
        version,
        source: act.source,
        activities: act.activities,
      };
    }

    const [actRes, sessRes] = await Promise.allSettled([
      fetchActivities(),
      fetchSessions(),
    ]);
    if (actRes.status === "rejected") throw actRes.reason;

    const out: {
      version: 11 | 12;
      source: "Threads" | "Jobs";
      activities: ActivityItem[];
      sessions?: SessionItem[];
      sessionsError?: string;
    } = {
      version,
      source: actRes.value.source,
      activities: actRes.value.activities,
    };
    if (sessRes.status === "fulfilled") {
      out.sessions = sessRes.value;
    } else {
      out.sessionsError =
        sessRes.reason instanceof Error
          ? sessRes.reason.message
          : String(sessRes.reason);
    }
    return out;
  }

  /**
   * Query TM1 TransactionLogEntries with time-bounded OData filtering (v11).
   * GET /api/v1/TransactionLogEntries
   */
  async queryTransactionLog(opts: {
    since: string;
    until?: string;
    cubeName?: string;
    user?: string;
    element?: string;
    top: number;
    skip: number;
    order: "asc" | "desc";
    request?: RequestOptions;
  }): Promise<{ total: number | undefined; entries: TransactionLogEntry[] }> {
    const clauses: string[] = [`TimeStamp ge ${opts.since}`];
    if (opts.until) clauses.push(`TimeStamp le ${opts.until}`);
    if (opts.cubeName) {
      clauses.push(`Cube eq '${escapeOdataLiteral(opts.cubeName)}'`);
    }
    if (opts.user) {
      clauses.push(`User eq '${escapeOdataLiteral(opts.user)}'`);
    }
    if (opts.element) {
      clauses.push(`Tuple/any(t: t eq '${escapeOdataLiteral(opts.element)}')`);
    }

    const skipPart = opts.skip > 0 ? `&$skip=${opts.skip}` : "";
    const path =
      `/api/v1/TransactionLogEntries?$filter=${encodeURIComponent(clauses.join(" and "))}` +
      `&$orderby=TimeStamp ${opts.order}&$top=${opts.top}${skipPart}&$count=true`;

    const response = await this.http.request<{
      "@odata.count"?: number;
      value?: Array<{
        ID?: number;
        ChangeSetID?: string;
        TimeStamp?: string;
        User?: string;
        Cube?: string;
        Tuple?: unknown[];
        OldValue?: CellValue;
        NewValue?: CellValue;
      }>;
    }>("GET", path, undefined, opts.request);

    const entries: TransactionLogEntry[] = (response.value ?? []).map((e) => ({
      ...(e.ID !== undefined ? { id: e.ID } : {}),
      ...(e.ChangeSetID !== undefined ? { changeSetId: e.ChangeSetID } : {}),
      timeStamp: e.TimeStamp ?? "",
      user: e.User ?? "",
      cube: e.Cube ?? "",
      tuple: Array.isArray(e.Tuple) ? e.Tuple.map(String) : [],
      oldValue: e.OldValue ?? null,
      newValue: e.NewValue ?? null,
    }));

    return { total: response["@odata.count"], entries };
  }

  /**
   * Query TM1 MessageLogEntries with time-bounded OData filtering (v11).
   * Secrets in Message text are masked via maskSecretValues().
   * GET /api/v1/MessageLogEntries
   */
  async queryMessageLog(opts: {
    since: string;
    until?: string;
    level?: string;
    logger?: string;
    search?: string;
    top: number;
    skip: number;
    order: "asc" | "desc";
    request?: RequestOptions;
  }): Promise<{ total: number | undefined; entries: MessageLogEntry[] }> {
    const clauses: string[] = [`TimeStamp ge ${opts.since}`];
    if (opts.until) clauses.push(`TimeStamp le ${opts.until}`);
    if (opts.level) {
      clauses.push(`Level eq '${escapeOdataLiteral(opts.level)}'`);
    }
    if (opts.logger) {
      clauses.push(`contains(Logger,'${escapeOdataLiteral(opts.logger)}')`);
    }
    if (opts.search) {
      clauses.push(`contains(Message,'${escapeOdataLiteral(opts.search)}')`);
    }

    const skipPart = opts.skip > 0 ? `&$skip=${opts.skip}` : "";
    const path =
      `/api/v1/MessageLogEntries?$filter=${encodeURIComponent(clauses.join(" and "))}` +
      `&$orderby=TimeStamp ${opts.order}&$top=${opts.top}${skipPart}&$count=true`;

    const response = await this.http.request<{
      "@odata.count"?: number;
      value?: Array<{
        ID?: number;
        TimeStamp?: string;
        Level?: string;
        Logger?: string;
        Message?: string;
        ThreadID?: number;
        SessionID?: number;
      }>;
    }>("GET", path, undefined, opts.request);

    const entries: MessageLogEntry[] = (response.value ?? []).map((e) => ({
      ...(e.ID !== undefined ? { id: e.ID } : {}),
      timeStamp: e.TimeStamp ?? "",
      level: e.Level ?? "",
      logger: e.Logger ?? "",
      message: maskSecretValues(e.Message ?? ""),
      ...(e.ThreadID !== undefined ? { threadId: e.ThreadID } : {}),
      ...(e.SessionID !== undefined ? { sessionId: e.SessionID } : {}),
    }));

    return { total: response["@odata.count"], entries };
  }
}
