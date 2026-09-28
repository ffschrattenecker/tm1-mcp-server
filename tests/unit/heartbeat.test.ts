import { describe, it, expect, vi, afterEach } from "vitest";
import { startHeartbeat } from "../../src/tools/heartbeat.js";

type Extra = Parameters<typeof startHeartbeat>[0];

afterEach(() => {
  vi.useRealTimers();
});

describe("startHeartbeat", () => {
  it("sends a progress notification every 5s until stopped", () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra = {
      _meta: { progressToken: "t1" },
      sendNotification,
    } as unknown as Extra;

    const stop = startHeartbeat(extra, "Nightly");
    vi.advanceTimersByTime(10_000);
    stop();
    vi.advanceTimersByTime(10_000);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenLastCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: "t1",
        progress: 10,
        message: "Nightly still running (10s elapsed)",
      },
    });
  });

  it("does nothing without a progress token", () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn();
    const stop = startHeartbeat(
      { sendNotification } as unknown as Extra,
      "Nightly",
    );
    vi.advanceTimersByTime(10_000);
    stop();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
