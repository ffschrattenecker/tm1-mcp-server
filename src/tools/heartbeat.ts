import { extraMeta, extraNotify, type ToolCallExtra } from "./context.js";

const HEARTBEAT_MS = 5000;

/**
 * TM1 REST exposes no mid-run progress for a TI run, so long-running
 * tools emit a progress notification every 5s instead. Keeps client UI alive
 * and lets users tell "still working" from "hung" — and a client that resets
 * its own timeout on progress keeps waiting instead of cancelling, which for
 * an async run would cancel it on the server. Heartbeat-only: total stays
 * undefined, since the duration is unknown ahead of time.
 *
 * No-op without a progressToken. Returns the stop function for `finally`.
 */
export function startHeartbeat(
  extra: ToolCallExtra | undefined,
  label: string,
): () => void {
  const meta = extraMeta(extra);
  const progressToken = meta?.progressToken as string | number | undefined;
  const notify = extraNotify(extra);
  if (progressToken === undefined || notify === undefined) return () => {};
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - start) / 1000);
    void notify({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsedSec,
        message: `${label} still running (${elapsedSec}s elapsed)`,
      },
    }).catch(() => undefined);
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}
