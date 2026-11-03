import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { makeTestConfig } from "../helpers/tm1-config.js";
import { mockLogger } from "../helpers/client-harness.js";

describe("R2-03: AbortSignal propagation through HTTP layer", () => {
  let client: TM1HttpClient;

  beforeEach(() => {
    const cfg = makeTestConfig({ requestTimeoutMs: 60000 });
    const sessionManager = new SessionManager(cfg, mockLogger);
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue(
      "session-cookie",
    );
    client = new TM1HttpClient(cfg, sessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not retry on a bare AbortError (cancellation is not a network blip)", async () => {
    // Regression: isNetworkError used to classify AbortError as retryable, so a
    // cancelled GET was retried up to 3×. A DOMException AbortError must abort
    // the request loop immediately — fetch is called exactly once.
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        ),
      );
    stubContractCheckedFetch(fetchSpy);

    await expect(
      client.request("GET", "/api/v1/Configuration"),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts in-flight fetch when external signal aborts", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchSpy = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        });
      });
    stubContractCheckedFetch(fetchSpy);

    const external = new AbortController();
    const promise = client.request("GET", "/api/v1/Configuration", undefined, {
      signal: external.signal,
    });

    queueMicrotask(() => external.abort(new Error("user cancelled")));

    await expect(promise).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
