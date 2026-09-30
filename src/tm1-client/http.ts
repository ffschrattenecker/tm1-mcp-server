// HTTP transport layer for TM1Client. Owns request/response, retry, auth-retry,
// and TM1-specific error classification. Domain methods live in tm1-client.ts.
import type pino from "pino";
import { connectionIdOf, type TM1Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import {
  createConnectionProfile,
  type ConnectionProfile,
} from "./connection/profile.js";
import { TM1Error, TM1ErrorCode } from "../types.js";
import { PRODUCT, VERSION } from "../version.js";
import { getTm1Dispatcher, tm1Fetch } from "./dispatcher.js";
import { tm1Events, type Tm1MutationEvent } from "../lib/tm1-events.js";
import { maskSecretValues } from "../lib/mask-secrets.js";

const MAX_NETWORK_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const USER_AGENT = `${PRODUCT}/${VERSION}`;

// Async operations (RequestOptions.async). Polling backs off from 0.1s to 1s.
// Without a caller timeoutMs the wait is capped at an hour — the tools'
// timeoutMs ceiling — not at the 30s single-request default, which a long TI
// run would otherwise hit while it is still running.
const ASYNC_POLL_MIN_MS = 100;
const ASYNC_POLL_MAX_MS = 1000;
const ASYNC_DEFAULT_BUDGET_MS = 3_600_000;
// Consecutive failed polls (network blip, per-poll timeout) tolerated before
// the run is reported as lost track of.
const ASYNC_MAX_POLL_FAILURES = 3;
const ASYNC_CANCEL_TIMEOUT_MS = 5000;

// R2-22: any successful mutating HTTP call invalidates the callgraph
// reference-index cache. Cheap (Map.clear()) and rebuild is lazy on next
// read — over-invalidation on non-graph-affecting calls (write_cells,
// upload_file, CheckRules) costs at most one rebuild. The alternative —
// per-service hooks across 17 mutation methods — risks drift as new
// mutating methods are added.
function isSafeHttpMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

// Per-call overrides for the global config defaults. timeoutMs caps long-running
// execute_mdx/process/chore; signal forwards an MCP-side AbortSignal (R2-03) so
// `notifications/cancelled` from a client terminates the in-flight fetch.
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  // Disable the safe-method network-retry loop for this call. Use for
  // deterministically-slow endpoints (e.g. the transaction log) where a
  // timeout means "too much data", not a transient blip — retrying just
  // multiplies the wait. Default: retries enabled for safe methods.
  retry?: boolean;
  // Run as a TM1 async operation (`Prefer: respond-async`). TM1 answers 202
  // and the result is polled from /_async('id'), so a long TI run never holds
  // one HTTP request open. timeoutMs then caps the whole wait (default: an
  // hour); running out stops the polling but leaves the run going. An aborted
  // signal DELETEs the operation, which cancels the run on the server —
  // measured on 11.8: the TI thread is gone and the result reads
  // "TM1UserException: Cancel".
  async?: boolean;
}

// Link an external AbortSignal (e.g. from RequestHandlerExtra.signal) to a
// locally-owned timeout AbortController. Returns an unsubscribe function the
// caller must invoke in `finally` to avoid leaking the listener after the
// request resolves. If the external signal is already aborted, propagates the
// reason immediately.
function linkAbortSignals(
  local: AbortController,
  external?: AbortSignal,
): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    local.abort(external.reason);
    return () => undefined;
  }
  const onAbort = (): void => local.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

export class TM1HttpClient {
  // config is private: it carries credentials (TM1Config.password), so it must
  // not be reachable as `client.config` from the service layer. Services get
  // only what they need — `version` (numeric getter) for version-conditional
  // paths and `logger` for structured logs.
  private readonly config: TM1Config;
  public readonly logger: pino.Logger;
  protected readonly sessionManager: SessionManager;
  // v11↔v12 URL-rerooting seam. v11: identity (paths unchanged). v12: rewrites
  // `/api/v1/...` to the database-rooted `/{instance}/api/v1/Databases('{db}')/...`.
  private readonly profile: ConnectionProfile;

  constructor(
    config: TM1Config,
    sessionManager: SessionManager,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.profile = createConnectionProfile(config);
  }

  private readonly mutationListeners: Array<(e: Tm1MutationEvent) => void> = [];

  /**
   * @internal — subscribe to THIS connection's successful mutations. Unlike
   * the process-global `tm1Events` bus, listeners die with the client, so a
   * per-connection cache needs no unsubscribe and never sees another
   * connection's writes.
   */
  public onMutation(listener: (e: Tm1MutationEvent) => void): void {
    this.mutationListeners.push(listener);
  }

  private emitMutation(method: string, path: string): void {
    if (isSafeHttpMethod(method)) return;
    const e = { method, path, connectionId: connectionIdOf(this.config) };
    tm1Events.emit("mutation", e);
    for (const listener of this.mutationListeners) listener(e);
  }

  /**
   * Make an authenticated HTTP request to the TM1 REST API.
   *
   * - Ensures an active session via SessionManager
   * - On 401: re-authenticates once and retries
   * - On network error for safe methods (GET/HEAD): retries up to 3 times with exponential backoff (1s, 2s, 4s)
   * - On network error for non-safe methods (POST/PUT/PATCH/DELETE): does NOT retry — these are not idempotent
   *   and a retry could spawn duplicate side-effects (e.g. parallel TI runs on tm1.Execute)
   * - On other HTTP errors: classifies and throws TM1Error
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(path)}`;
    const isSafeMethod = isSafeHttpMethod(method);
    const allowRetry = opts?.retry !== false;
    const maxAttempts = isSafeMethod && allowRetry ? MAX_NETWORK_RETRIES : 0;
    const isAsync = opts?.async === true;
    // Async: the POST itself returns at once, and a server that ignores the
    // preference answers synchronously — so the budget covers either.
    const timeoutMs = isAsync
      ? (opts?.timeoutMs ?? ASYNC_DEFAULT_BUDGET_MS)
      : opts?.timeoutMs;
    const budgetMs = timeoutMs ?? this.config.requestTimeoutMs;
    const deadline = Date.now() + budgetMs;
    const extraHeaders: Record<string, string> | undefined = isAsync
      ? { Prefer: "respond-async" }
      : undefined;
    const settle = async (response: Response): Promise<T> => {
      const final =
        isAsync && response.status === 202
          ? await this.awaitAsync(
              response,
              path,
              deadline,
              budgetMs,
              opts?.signal,
            )
          : response;
      const result = await this.handleResponse<T>(final, path);
      this.emitMutation(method, path);
      return result;
    };
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          { attempt, delayMs, endpoint: path },
          "Retrying after network error",
        );
        await sleep(delayMs);
      }

      try {
        const cookie = await this.sessionManager.ensureSession();
        const response = await this.executeRequest(
          url,
          method,
          cookie,
          body,
          timeoutMs,
          opts?.signal,
          extraHeaders,
        );

        if (response.status === 401) {
          this.logger.warn(
            { endpoint: path },
            "Received 401, re-authenticating",
          );
          // Pass the cookie that got the 401 so a concurrent request that
          // already rotated the session short-circuits to the fresh cookie
          // instead of forcing another logout+login (staggered-401 churn).
          const newCookie = await this.sessionManager.authenticate(cookie);
          const retryResponse = await this.executeRequest(
            url,
            method,
            newCookie,
            body,
            timeoutMs,
            opts?.signal,
            extraHeaders,
          );

          if (retryResponse.status === 401) {
            throw new TM1Error({
              code: TM1ErrorCode.AUTH_FAILED,
              message: "Authentication failed after re-authentication attempt",
              httpStatus: 401,
              endpoint: path,
            });
          }

          return await settle(retryResponse);
        }

        return await settle(response);
      } catch (error) {
        if (error instanceof TM1Error) {
          throw error;
        }

        if (isTimeoutError(error)) {
          const ms = budgetMs;
          throw new TM1Error({
            code: TM1ErrorCode.LOCK_TIMEOUT,
            message: `Request to ${path} timed out after ${ms}ms`,
            endpoint: path,
            hint: isSafeMethod
              ? "Query timed out — result set may be too large. Add filters or reduce scope. If a lock is suspected, read Threads (v11) or Jobs (v12) with tm1_rest_read."
              : "Request timed out — TM1 server may be waiting on a lock held by another session. Read Threads (v11) or Jobs (v12) with tm1_rest_read to find it; cancel it with tm1_rest_write (POST Threads(id)/tm1.CancelOperation or Jobs('id')/tm1.Cancel).",
          });
        }

        if (opts?.signal?.aborted) {
          throw error;
        }

        if (this.isNetworkError(error)) {
          lastError = error;
          this.logger.error(
            { err: error, attempt, endpoint: path },
            "Network error during request",
          );
          continue;
        }

        throw new TM1Error({
          code: TM1ErrorCode.CONNECTION_FAILED,
          message: error instanceof Error ? error.message : String(error),
          endpoint: path,
        });
      }
    }

    throw new TM1Error({
      code: TM1ErrorCode.CONNECTION_FAILED,
      message: isSafeMethod
        ? `Request failed after ${MAX_NETWORK_RETRIES} retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : `Request failed (no retry for ${method}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      endpoint: path,
    });
  }

  /**
   * Make an authenticated HTTP request that returns raw text (not JSON).
   * Used for file content downloads where the response is CSV/TXT/etc.
   * Re-auths once on 401 like request().
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async requestRaw(
    method: string,
    path: string,
    opts?: RequestOptions,
  ): Promise<string> {
    return (await this.fetchRaw(method, path, opts)).text();
  }

  /**
   * Same request as requestRaw, but hands back the bytes instead of a string.
   *
   * requestRaw decodes the body as UTF-8, which silently destroys anything
   * that is not text — a spreadsheet read that way comes back as replacement
   * characters. Callers that may face binary content use this and decide how
   * to present it.
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async requestRawBytes(
    method: string,
    path: string,
    opts?: RequestOptions,
  ): Promise<Buffer> {
    const res = await this.fetchRaw(method, path, opts);
    return Buffer.from(await res.arrayBuffer());
  }

  private async fetchRaw(
    method: string,
    path: string,
    opts?: RequestOptions,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(path)}`;
    const effectiveTimeout = opts?.timeoutMs ?? this.config.requestTimeoutMs;
    const cookie = await this.sessionManager.ensureSession();

    const headers: Record<string, string> = {
      Cookie: this.sessionManager.cookieHeader(cookie),
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      "TM1-SessionContext": USER_AGENT,
      "TM1-Session-Context": USER_AGENT,
    };

    const response = await this.withReauth(
      (c) => {
        const hdrs = {
          ...headers,
          Cookie: this.sessionManager.cookieHeader(c),
        };
        return this.sendOnce(
          url,
          method,
          hdrs,
          undefined,
          effectiveTimeout,
          opts?.signal,
        );
      },
      cookie,
      path,
      effectiveTimeout,
    );

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        /* ignore */
      }
      throw this.classifyHttpError(response.status, path, body || undefined);
    }
    this.emitMutation(method, path);
    return response;
  }

  /**
   * Make an authenticated HTTP request with a binary body (Buffer/Uint8Array).
   * Used for blob/file uploads where the body is raw bytes (not JSON).
   * Sends Content-Type: application/octet-stream by default.
   * Re-auths once on 401 like request(). No network-error retries (non-safe methods).
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async requestBinary(
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string = "application/octet-stream",
    opts?: RequestOptions,
  ): Promise<void> {
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(path)}`;
    const effectiveTimeout = opts?.timeoutMs ?? this.config.requestTimeoutMs;
    const cookie = await this.sessionManager.ensureSession();

    const response = await this.withReauth(
      (c) =>
        this.sendOnce(
          url,
          method,
          {
            Cookie: this.sessionManager.cookieHeader(c),
            Accept: "application/json,*/*",
            "Content-Type": contentType,
            "User-Agent": USER_AGENT,
            "TM1-SessionContext": USER_AGENT,
            "TM1-Session-Context": USER_AGENT,
          },
          body,
          effectiveTimeout,
          opts?.signal,
        ),
      cookie,
      path,
      effectiveTimeout,
    );

    if (!response.ok) {
      let errBody = "";
      try {
        errBody = await response.text();
      } catch {
        /* ignore */
      }
      throw this.classifyHttpError(response.status, path, errBody || undefined);
    }
    this.emitMutation(method, path);
  }

  /**
   * Low-level single fetch with timeout + AbortSignal wiring.
   * Does NOT handle 401, retries, or error classification — callers own that.
   */
  private async sendOnce(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(new DOMException("Request timed out", "TimeoutError")),
      timeoutMs,
    );
    const unlink = linkAbortSignals(controller, externalSignal);
    try {
      return await tm1Fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        dispatcher: getTm1Dispatcher(this.config),
      } as unknown as RequestInit);
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  /**
   * Wraps a send function with cookie-refresh-on-401 and timeout→LOCK_TIMEOUT mapping.
   * Used by requestRaw and requestBinary (which have no network-retry loop).
   * On 401: calls sessionManager.authenticate() and retries once with the new cookie.
   * The caller is responsible for obtaining the initial cookie via ensureSession().
   */
  private async withReauth(
    send: (cookie: string) => Promise<Response>,
    initialCookie: string,
    path: string,
    effectiveTimeout: number,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await send(initialCookie);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new TM1Error({
          code: TM1ErrorCode.LOCK_TIMEOUT,
          message: `Request to ${path} timed out after ${effectiveTimeout}ms`,
          endpoint: path,
        });
      }
      throw err;
    }
    if (response.status === 401) {
      const newCookie = await this.sessionManager.authenticate(initialCookie);
      try {
        response = await send(newCookie);
      } catch (err) {
        if (isTimeoutError(err)) {
          throw new TM1Error({
            code: TM1ErrorCode.LOCK_TIMEOUT,
            message: `Request to ${path} timed out after ${effectiveTimeout}ms`,
            endpoint: path,
          });
        }
        throw err;
      }
    }
    return response;
  }

  private async executeRequest(
    url: string,
    method: string,
    cookie: string,
    body?: unknown,
    timeoutMs?: number,
    externalSignal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Cookie: this.sessionManager.cookieHeader(cookie),
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": USER_AGENT,
      "TM1-SessionContext": USER_AGENT,
      "TM1-Session-Context": USER_AGENT,
      ...extraHeaders,
    };

    const isWriteMethod =
      method === "POST" || method === "PUT" || method === "PATCH";
    if (body !== undefined || isWriteMethod) {
      headers["Content-Type"] = "application/json";
    }

    const serializedBody: string | undefined =
      body !== undefined
        ? JSON.stringify(body)
        : isWriteMethod
          ? ""
          : undefined;

    return this.sendOnce(
      url,
      method,
      headers,
      serializedBody,
      timeoutMs ?? this.config.requestTimeoutMs,
      externalSignal,
    );
  }

  /**
   * Poll an accepted (202) async operation until TM1 has the result, and hand
   * that result back as the Response the synchronous call would have given.
   *
   * Measured on 11.8: the Location is relative and not consistently so —
   * `../_async('id')` from a bound action, `_async('id')` from an unbound one
   * — so only the id is taken from it and the path is rebuilt through the
   * profile (v12 reroots it under the database). A poll answers 202 while the
   * run lasts, then 200 carrying the real status in the `asyncresult` header
   * ("201 Created", "204 No Content", "500 Internal Server Error") and the real
   * body as its own.
   *
   * Anything that goes wrong with the polling itself is CONNECTION_FAILED —
   * systemic, never NOT_FOUND. A poll 404 (an expired id, or a re-auth into a
   * new session the id does not belong to) says nothing about the resource,
   * and ChoreService re-runs the chore on a NOT_FOUND.
   */
  private async awaitAsync(
    accepted: Response,
    path: string,
    deadline: number,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const id = /_async\('([^']+)'\)/.exec(
      accepted.headers.get("location") ?? "",
    )?.[1];
    if (id === undefined) {
      throw lostTrack(
        path,
        "TM1 accepted the request (202) but named no _async operation",
      );
    }
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(`/api/v1/_async('${id}')`)}`;
    let delay = ASYNC_POLL_MIN_MS;
    let failures = 0;
    try {
      for (;;) {
        await abortableSleep(delay, signal);
        delay = Math.min(delay * 2, ASYNC_POLL_MAX_MS);
        let res: Response;
        try {
          res = await this.pollAsync(url, signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          if (!isTimeoutError(e) && !this.isNetworkError(e)) throw e;
          if (++failures >= ASYNC_MAX_POLL_FAILURES) {
            throw lostTrack(path, e instanceof Error ? e.message : String(e));
          }
          continue;
        }
        failures = 0;
        if (res.status === 200) return await asyncResult(res);
        if (res.status !== 202) {
          throw lostTrack(path, `polling answered HTTP ${res.status}`);
        }
        if (Date.now() >= deadline) {
          throw new TM1Error({
            code: TM1ErrorCode.LOCK_TIMEOUT,
            message: `${path} was still running on the TM1 server when the ${budgetMs}ms wait ran out. It was NOT cancelled.`,
            endpoint: path,
            hint: "Only the waiting stopped, not the run. Watch it with tm1_rest_read on Threads (v11) or Jobs (v12) and do not re-run it meanwhile; pass a larger timeoutMs next time.",
          });
        }
      }
    } catch (e) {
      if (signal?.aborted) await this.cancelAsync(url, path);
      throw e;
    }
  }

  /** One poll of an async operation, re-authenticating once on a 401. */
  private async pollAsync(
    url: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const cookie = await this.sessionManager.ensureSession();
    const res = await this.executeRequest(
      url,
      "GET",
      cookie,
      undefined,
      undefined,
      signal,
    );
    if (res.status !== 401) return res;
    const newCookie = await this.sessionManager.authenticate(cookie);
    return this.executeRequest(
      url,
      "GET",
      newCookie,
      undefined,
      undefined,
      signal,
    );
  }

  /**
   * DELETE an async operation, best-effort: this cancels the run it stands
   * for. Deliberately without the caller's signal — that one is already
   * aborted, which is why we are here.
   */
  private async cancelAsync(url: string, path: string): Promise<void> {
    try {
      const cookie = await this.sessionManager.ensureSession();
      const res = await this.sendOnce(
        url,
        "DELETE",
        {
          Cookie: this.sessionManager.cookieHeader(cookie),
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "TM1-SessionContext": USER_AGENT,
          "TM1-Session-Context": USER_AGENT,
        },
        undefined,
        ASYNC_CANCEL_TIMEOUT_MS,
      );
      this.logger.warn(
        { endpoint: path, status: res.status },
        "Cancelled async TM1 operation",
      );
    } catch (err) {
      this.logger.error(
        { err, endpoint: path },
        "Could not cancel async TM1 operation",
      );
    }
  }

  private async handleResponse<T>(
    response: Response,
    endpoint: string,
  ): Promise<T> {
    if (response.ok) {
      const text = await response.text();
      if (response.status === 204 || !text) {
        return undefined as T;
      }
      this.logger.debug(
        { endpoint, status: response.status },
        "Request successful",
      );
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message:
            `TM1 returned a non-JSON response body (status ${response.status}) for ${endpoint}. ` +
            `This usually means a proxy or gateway returned HTML/text instead of the TM1 REST API.`,
          httpStatus: response.status,
          endpoint,
        });
      }
    }

    let details: string | undefined;
    let errorBody: string;
    try {
      errorBody = await response.text();
      if (errorBody) {
        const parsed: unknown = JSON.parse(errorBody);
        details = odataErrorText(parsed) ?? errorBody;
      }
    } catch {
      /* ignore parse errors */
    }

    const error = this.classifyHttpError(response.status, endpoint, details);
    this.logger.error(
      { endpoint, status: response.status, code: error.code },
      error.message,
    );
    throw error;
  }

  private classifyHttpError(
    status: number,
    endpoint: string,
    details?: string,
  ): TM1Error {
    return classifyHttpError(status, endpoint, details);
  }

  private isNetworkError(error: unknown): boolean {
    return isNetworkErrorImpl(error);
  }
}

/**
 * Map an HTTP status + TM1 error text onto a TM1Error. Module-level (not just a
 * TM1HttpClient method) because `$batch` sub-responses arrive as plain
 * {status, body} records inside a 200 envelope — BatchService has to classify
 * them itself, and must do it identically to a standalone request rather than
 * with a drifting copy of these rules.
 */
export function classifyHttpError(
  status: number,
  endpoint: string,
  rawDetails?: string,
): TM1Error {
  // S4/S5: sanitize ONCE, here, where the server's own text enters our error
  // model. Everything downstream reads the TM1Error this builds — the
  // logger.error() in handleResponse and the MCP error envelope alike — so
  // masking here covers both exits with no chance of one being forgotten.
  //
  // This is the gap key-based redaction cannot close: pino's `redact` masks a
  // field NAMED password, but a TM1 failure such as
  // "[ODBC Driver] login failed for PWD=hunter2" is a plain message string, and
  // it went to the log and back to the client verbatim.
  const details =
    rawDetails === undefined ? undefined : maskSecretValues(rawDetails);
  {
    // TM1 signals object-level security denial via the error MESSAGE, often
    // with HTTP 400 (not 403) — e.g. reading a control cube as a non-admin
    // returns 400 {"error":{"code":"65","message":"ObjectSecurityNoReadRights"}}.
    // Classify by message so the caller gets PERMISSION_DENIED + its actionable
    // hint instead of a generic TM1_ERROR. Verified live with a cube-only user.
    if (
      details &&
      /No(Read|Write|Admin)Rights|ObjectSecurity|SecurityAccess|not\s+authori[sz]ed/i.test(
        details,
      )
    ) {
      return new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message: details,
        httpStatus: status,
        endpoint,
        details,
      });
    }
    switch (status) {
      case 401:
        return new TM1Error({
          code: TM1ErrorCode.AUTH_FAILED,
          message: details ?? "Authentication failed",
          httpStatus: status,
          endpoint,
          details,
        });
      case 403:
        return new TM1Error({
          code: TM1ErrorCode.PERMISSION_DENIED,
          message: details ?? "Permission denied",
          httpStatus: status,
          endpoint,
          details,
        });
      case 404:
        return new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: details ?? "Resource not found",
          httpStatus: status,
          endpoint,
          details,
        });
      case 409:
        return new TM1Error({
          code: TM1ErrorCode.CONFLICT,
          message: details ?? "Resource conflict",
          httpStatus: status,
          endpoint,
          details,
        });
      default:
        return new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: details ?? `TM1 API error (HTTP ${status})`,
          httpStatus: status,
          endpoint,
          details,
        });
    }
  }
}

/**
 * Is this a transient transport failure worth retrying (as opposed to our own
 * timeout, a caller cancellation, or an application-level error)?
 */
function isNetworkErrorImpl(error: unknown): boolean {
  {
    // TimeoutError is our own request timeout — handled separately as LOCK_TIMEOUT,
    // never treated as a retryable network blip.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return false;
    }
    // AbortError is never a retryable network blip. Our own request timeout
    // aborts with name "TimeoutError" (handled above → LOCK_TIMEOUT). A plain
    // "AbortError" can only come from a caller-supplied signal (cancellation),
    // which must propagate immediately — retrying a cancelled request 3× is a
    // bug. The request loop also guards opts.signal.aborted before reaching
    // here; this is the defensive backstop for any other abort source. Match on
    // name (not just DOMException) since some fetch impls throw a plain Error.
    if (error instanceof Error && error.name === "AbortError") {
      return false;
    }

    // Primary, robust path: undici surfaces the OS-level failure on the wrapped
    // cause's `.code` (e.g. ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ECONNRESET). Some
    // raw socket errors expose `.code` directly. Classifying by code is stable
    // across Node/undici versions and locale, unlike message-substring matching.
    const causeCode = errorCodeOf((error as { cause?: unknown }).cause);
    if (causeCode !== undefined && NETWORK_ERROR_CODES.has(causeCode)) {
      return true;
    }
    const directCode = errorCodeOf(error);
    if (directCode !== undefined && NETWORK_ERROR_CODES.has(directCode)) {
      return true;
    }

    // Fallback: undici wraps every fetch-level network failure in
    // `TypeError: fetch failed`. This catches wrappers whose cause carries no
    // recognised code (or no cause at all) — preserves the old TypeError branch.
    if (error instanceof TypeError) {
      return true;
    }

    // Last-resort backstop: an error that stringified a network failure into its
    // message without exposing a code or cause (rare, but the old code matched
    // it — kept so nothing is silently dropped). Not the primary classifier.
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("fetch failed") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("etimedout") ||
        msg.includes("network")
      );
    }
    return false;
  }
}

/**
 * OS/undici-level error codes that indicate a transient network failure worth
 * retrying (connection refused, DNS failure, timeout, socket reset, etc.).
 * undici exposes these on `err.cause.code`; raw sockets on `err.code`.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", // connection actively refused (server down / wrong port)
  "ENOTFOUND", // DNS: host not found
  "EAI_AGAIN", // DNS: temporary resolution failure
  "ETIMEDOUT", // OS-level connect/read timeout
  "ECONNRESET", // socket reset by peer
  "ECONNABORTED", // connection aborted mid-flight
  "EPIPE", // broken pipe writing to a closed socket
  "EHOSTUNREACH", // host unreachable
  "ENETUNREACH", // network unreachable
  "ENETDOWN", // network is down
  "UND_ERR_CONNECT_TIMEOUT", // undici connect timeout
  "UND_ERR_SOCKET", // undici socket error (e.g. other side closed)
]);

/**
 * Read a string `.code` off an unknown error-ish value, narrowing safely under
 * strict TS (`cause`/`error` are `unknown`). Returns undefined if absent or not
 * a string.
 */
function errorCodeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Pull the message out of an OData error body. TM1 writes it two ways —
 * `error.message` as a plain string, or `error.message.value` — so both are
 * read, and anything else yields undefined so the caller can fall back to the
 * raw body. Returning only strings matters: the previous chained-optional
 * version could hand a whole object to a `string` field when `message` was an
 * object without `value`.
 */
function odataErrorText(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") return message;
  if (typeof message === "object" && message !== null) {
    const value = (message as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** The polling lost the run: its outcome is unknown, never "not found". */
function lostTrack(path: string, why: string): TM1Error {
  return new TM1Error({
    code: TM1ErrorCode.CONNECTION_FAILED,
    message: `Lost track of the async run of ${path}: ${why}. It may still be running, or may have finished.`,
    endpoint: path,
    hint: "The outcome is unknown. Check Threads (v11) or Jobs (v12) and MessageLogEntries (v11) with tm1_rest_read before running it again — a re-run risks a duplicate execution.",
  });
}

/**
 * The final poll of an async operation, as the response the synchronous call
 * would have given: status from the `asyncresult` header, body as sent. With
 * no header the poll's own status stands.
 */
async function asyncResult(res: Response): Promise<Response> {
  const status = Number.parseInt(res.headers.get("asyncresult") ?? "", 10);
  if (!Number.isInteger(status) || status === res.status) return res;
  const text = await res.text();
  return new Response(status === 204 || !text ? null : text, { status });
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const reason = (): Error =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("This operation was aborted", "AbortError");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(reason());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(reason());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
