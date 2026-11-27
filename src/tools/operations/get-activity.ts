import { z } from "zod";
import type { ActivityItem, SessionItem } from "../../types.js";
import {
  FORMAT_SCHEMA,
  columnsOf,
  payloadResponse,
  renderTable,
} from "../format.js";
import { READ_ONLY } from "../annotations.js";
import { ActivitySnapshotResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { extraSignal } from "../context.js";

function isWaiting(a: ActivityItem): boolean {
  return (
    /wait|block|queue/i.test(a.state) ||
    (a.waitSeconds ?? 0) > 0 ||
    (a.waitingOn?.length ?? 0) > 0
  );
}

function isLockHolder(a: ActivityItem): boolean {
  return (a.locks?.write ?? 0) > 0 || (a.locks?.intentWrite ?? 0) > 0;
}

function isIdle(a: ActivityItem): boolean {
  return a.state.toLowerCase() === "idle" && !isLockHolder(a) && !isWaiting(a);
}

function activityRank(a: ActivityItem): number {
  if (isWaiting(a)) return 0;
  if (isLockHolder(a)) return 1;
  if (!isIdle(a)) return 2;
  return 3;
}

export const registerGetActivity = defineTool({
  name: "tm1_get_activity",
  description: [
    "Snapshot live TM1 server activity and lock contention (Threads on v11, Jobs on v12) plus active Sessions.",
    "Highlights waiting threads/jobs, write/intent-write lock holders, and longest elapsed/wait times.",
    "Use to diagnose slow queries, locks, or hung TI processes.",
  ],
  annotations: READ_ONLY,
  output: ActivitySnapshotResultSchema,
  input: {
    includeIdle: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include idle and background threads/jobs (default false)."),
    includeSessions: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Include active Sessions alongside Threads (v11) / Jobs (v12) (default true).",
      ),
    user: z
      .string()
      .optional()
      .describe("Case-insensitive substring filter on user name."),
    minElapsedSeconds: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Only return activities with elapsedSeconds >= this threshold.",
      ),
    ...FORMAT_SCHEMA,
  },
  handler: async (
    { includeIdle, includeSessions, user, minElapsedSeconds, format },
    tm1Client,
    extra,
  ) => {
    const snapshot = await tm1Client.server.getActivitySnapshot({
      includeSessions,
      request: { signal: extraSignal(extra) },
    });

    const all = snapshot.activities;
    const waiters = all.filter(isWaiting).map((a) => a.id);
    const lockHolders = all.filter(isLockHolder).map((a) => a.id);
    const activeCount = all.filter((a) => !isIdle(a)).length;
    const hasContention = waiters.length > 0;

    let longestElapsedSeconds: number | null = null;
    let longestWaitSeconds: number | null = null;
    for (const a of all) {
      if (
        a.elapsedSeconds !== undefined &&
        (longestElapsedSeconds === null ||
          a.elapsedSeconds > longestElapsedSeconds)
      ) {
        longestElapsedSeconds = a.elapsedSeconds;
      }
      if (
        a.waitSeconds !== undefined &&
        a.waitSeconds > 0 &&
        (longestWaitSeconds === null || a.waitSeconds > longestWaitSeconds)
      ) {
        longestWaitSeconds = a.waitSeconds;
      }
    }

    const userNeedle = user?.trim().toLowerCase();
    let idleOmitted = 0;
    const filtered = all.filter((a) => {
      if (!includeIdle && isIdle(a)) {
        idleOmitted++;
        return false;
      }
      if (userNeedle && !(a.user ?? "").toLowerCase().includes(userNeedle)) {
        return false;
      }
      if (
        minElapsedSeconds !== undefined &&
        (a.elapsedSeconds ?? 0) < minElapsedSeconds
      ) {
        return false;
      }
      return true;
    });

    filtered.sort(
      (a, b) =>
        activityRank(a) - activityRank(b) ||
        (b.elapsedSeconds ?? 0) - (a.elapsedSeconds ?? 0),
    );

    const warnings: string[] = [];
    if (hasContention) {
      const cancelHint =
        snapshot.version === 12
          ? "Cancel a blocking job with tm1_rest_write POST Jobs('id')/tm1.Cancel."
          : "Cancel a blocking thread with tm1_rest_write POST Threads(id)/tm1.CancelOperation.";
      warnings.push(
        `Contention detected: ${waiters.length} waiting ${snapshot.source.toLowerCase()} (${waiters.join(", ")}). ${cancelHint}`,
      );
    }
    if (snapshot.sessionsError) {
      warnings.push(
        `Sessions query failed (${snapshot.sessionsError}) — returning ${snapshot.source} only.`,
      );
    }

    const payload = {
      version: snapshot.version,
      source: snapshot.source,
      summary: {
        totalActivities: all.length,
        activeCount,
        waitingCount: waiters.length,
        idleOmitted,
        sessionCount: snapshot.sessions ? snapshot.sessions.length : null,
        hasContention,
        lockHolders,
        waiters,
        longestElapsedSeconds,
        longestWaitSeconds,
      },
      activities: filtered,
      ...(snapshot.sessions !== undefined
        ? { sessions: snapshot.sessions }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    const actCols = columnsOf<ActivityItem>([
      "id",
      "user",
      "state",
      "operation",
      "objectName",
      "elapsedSeconds",
      "waitSeconds",
      {
        header: "locks(R/IX/W)",
        get: (a) =>
          a.locks
            ? `${a.locks.read}/${a.locks.intentWrite}/${a.locks.write}`
            : "",
      },
    ]);
    const sessCols = columnsOf<SessionItem>([
      "id",
      "user",
      "friendlyName",
      "active",
      "context",
    ]);

    return payloadResponse(payload, format, (p) => {
      const lines = [
        `## TM1 Activity Snapshot (v${p.version} · ${p.source})`,
        "",
        `Total: ${p.summary.totalActivities} · Active: ${p.summary.activeCount} · Waiting: ${p.summary.waitingCount} · Idle omitted: ${p.summary.idleOmitted} · Contention: ${p.summary.hasContention}`,
      ];
      if (p.warnings?.length) {
        lines.push("", ...p.warnings.map((w) => `> ${w}`));
      }
      lines.push("", "### Activities", "", renderTable(p.activities, actCols));
      if (p.sessions) {
        lines.push("", "### Sessions", "", renderTable(p.sessions, sessCols));
      }
      return lines.join("\n");
    });
  },
});
