// Generic REST passthrough for the tm1_rest_read / tm1_rest_write tools.
//
// Every other service owns one domain and shapes its responses; this one only
// carries a caller-supplied path to the transport, so the tools keep going
// through the same session reuse, 401 handling, error classification, v12
// rerooting and never-retry-non-GET rules as the rest of the client. It does
// NO path checking of its own — src/tools/rest/guard.ts decides what may be
// sent, and must run before any call here.
//
// Paths are relative to /api/v1/ (e.g. "Cubes?$select=Name"), exactly as the
// guard returns them.
import type { RequestOptions, TM1HttpClient } from "../http.js";

/** A response body: parsed JSON when it is JSON, raw text otherwise. */
export type RestBody =
  | { kind: "json"; json: unknown }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export class RestService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * GET a path and return its body. Goes through requestRaw rather than
   * request(): request() refuses a non-JSON body, and plain-text endpoints
   * (ErrorLogFiles('x')/Content, .../$value, $count) are legitimate reads.
   * Cost: requestRaw has no network-retry loop.
   */
  async get(path: string, opts?: RequestOptions): Promise<RestBody> {
    return parseBody(await this.http.requestRaw("GET", apiPath(path), opts));
  }

  /**
   * Send a non-GET request with an optional JSON body. request() never
   * retries a non-safe method, so a dropped POST is not replayed.
   */
  async send(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<RestBody> {
    const json = await this.http.request<unknown>(
      method,
      apiPath(path),
      body,
      opts,
    );
    return json === undefined ? { kind: "empty" } : { kind: "json", json };
  }
}

function apiPath(path: string): string {
  return `/api/v1/${path}`;
}

function parseBody(text: string): RestBody {
  if (text === "") return { kind: "empty" };
  try {
    return { kind: "json", json: JSON.parse(text) as unknown };
  } catch {
    return { kind: "text", text };
  }
}
