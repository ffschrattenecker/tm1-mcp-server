import { describe, it, expect, vi, afterEach } from "vitest";
import { Writable } from "node:stream";
import {
  extractTraceContext,
  parseTraceparent,
  runWithTraceContext,
  traceLogBindings,
  traceOutboundHeaders,
} from "../../src/lib/trace-context.js";
import { createLogger } from "../../src/logger.js";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { stubSession } from "../helpers/client-harness.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";

describe("trace-context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses valid W3C traceparent and rejects invalid / all-zero IDs", () => {
    const ok = parseTraceparent(
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
    );
    expect(ok).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });

    expect(
      parseTraceparent(
        "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      ),
    ).toBeUndefined();
    expect(
      parseTraceparent(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      ),
    ).toBeUndefined();
    expect(
      parseTraceparent(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      ),
    ).toBeUndefined();
    expect(parseTraceparent("not-a-traceparent")).toBeUndefined();
  });

  it("prefers MCP _meta over HTTP headers and falls back to HTTP headers", () => {
    const metaCtx = extractTraceContext(
      {
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        tracestate: "congo=t61rcWkgMzE",
      },
      new Headers({
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-00",
      }),
    );
    expect(metaCtx?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(metaCtx?.tracestate).toBe("congo=t61rcWkgMzE");

    const httpCtx = extractTraceContext(
      undefined,
      new Headers({
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
      }),
    );
    expect(httpCtx?.traceId).toBe("cccccccccccccccccccccccccccccccc");
  });

  it("injects trace_id/span_id into pino logs and traceparent into outbound TM1 requests", async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger({ logLevel: "info" }, dest);
    const config = makeTestConfig();
    const sm = stubSession(config);
    const client = new TM1HttpClient(config, sm, logger);

    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      );
    stubContractCheckedFetch(fetchSpy);

    // Without active trace context: no trace headers or log bindings.
    expect(traceLogBindings()).toEqual({});
    expect(traceOutboundHeaders()).toEqual({});

    const ctx = extractTraceContext({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=val",
    });

    await runWithTraceContext(ctx, async () => {
      const child = logger.child({ tool: "tm1_rest_read" });
      child.info("running");
      await client.request("GET", "/api/v1/Cubes");
    });

    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(record.span_id).toBe("00f067aa0ba902b7");
    expect(record.trace_flags).toBe("01");
    expect(record.tool).toBe("tm1_rest_read");

    const reqInit = fetchSpy.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
    };
    expect(reqInit.headers.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(reqInit.headers.tracestate).toBe("vendor=val");
  });
});
