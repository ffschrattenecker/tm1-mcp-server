// Chore domain service. Owns the OData calls under /api/v1/Chores(...) —
// listing, scheduling toggle, immediate execution, create/update/delete.
//
// See docs/ARCHITECTURE.md for the layering.
import {
  CHORE_STATUS_UNAVAILABLE,
  TM1Error,
  TM1ErrorCode,
} from "../../types.js";
import type { Chore, ChoreCreate, ChoreResult } from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";
import { classifyChoreExecution } from "./chore-status.js";
import { rethrowIfSystemic } from "./fallback.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string =>
  encodeURIComponent(String(s).replace(/'/g, "''"));

function frequencyDuration(f: ChoreCreate["frequency"]): string {
  return `P${f.days}DT${String(f.hours).padStart(2, "0")}H${String(f.minutes).padStart(2, "0")}M${String(f.seconds).padStart(2, "0")}S`;
}

export class ChoreService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Connection-scoped verdict on `tm1.ExecuteWithReturn` for chores: null until
   * the first run has told us, then sticky. Only ever set to false by the
   * proof described in `execute()` — never by a version guess.
   */
  private withReturnSupported: boolean | null = null;

  /**
   * List all chores with their tasks (process + parameters per step).
   * GET /api/v1/Chores?$expand=Tasks($expand=Process($select=Name))
   */
  async list(): Promise<Chore[]> {
    // Expand Process inside Tasks — without it, Task.Process is omitted and the map
    // below sees undefined for every task.
    const response = await this.http.request<{
      value: Array<{
        Name: string;
        Active: boolean;
        StartTime: string;
        DSTSensitive: boolean;
        Frequency: string;
        Tasks?: Array<{
          Step: number;
          Parameters?: Array<{ Name: string; Value: string | number }>;
          Process?: { Name: string };
        }>;
      }>;
    }>("GET", "/api/v1/Chores?$expand=Tasks($expand=Process($select=Name))");

    return response.value.map((ch) => ({
      name: ch.Name,
      active: ch.Active,
      startTime: ch.StartTime,
      frequency: ch.Frequency,
      processes: (ch.Tasks ?? []).map((t) => ({
        name: t.Process?.Name ?? "<unknown>",
        parameters: Object.fromEntries(
          (t.Parameters ?? []).map((p) => [p.Name, p.Value]),
        ),
      })),
    }));
  }

  /**
   * Activate or deactivate a chore.
   * PATCH /api/v1/Chores('{name}') with { Active: bool }
   */
  async toggleActive(choreName: string, active: boolean): Promise<void> {
    const path = `/api/v1/Chores('${enc(choreName)}')`;
    await this.http.request<void>("PATCH", path, { Active: active });
  }

  /**
   * Execute a chore immediately (bypass its schedule), and report how it ended.
   * opts.timeoutMs overrides the 30s default for chores that run long TI chains.
   *
   * Both actions here are SYNCHRONOUS — the POST returns when the chore is
   * done, which is why the tool exposes a timeout ceiling of an hour. Using
   * `tm1.ExecuteWithReturn` therefore costs no extra waiting; it only stops us
   * throwing the status away.
   *
   * POST /api/v1/Chores('{name}')/tm1.ExecuteWithReturn?$expand=ErrorLogFile
   *   — v12 12.5.0 and up. `$expand` is REQUIRED: ErrorLogFile is a navigation
   *     property on ChoreExecuteResult, so without it the filename is silently
   *     absent (the same trap as ProcessService.execute).
   * POST /api/v1/Chores('{name}')/tm1.Execute
   *   — everywhere else. Returns 204, so no status exists to report.
   */
  async execute(
    choreName: string,
    opts?: RequestOptions,
  ): Promise<ChoreResult> {
    const plain = `/api/v1/Chores('${enc(choreName)}')/tm1.Execute`;

    if (this.withReturnSupported === false) {
      return this.executeWithoutStatus(plain, opts);
    }

    const withReturn = `/api/v1/Chores('${enc(choreName)}')/tm1.ExecuteWithReturn?$expand=ErrorLogFile`;
    try {
      const response = await this.http.request<{
        ChoreExecuteStatusCode?: string;
        ErrorLogFile?: { Filename?: string } | null;
      }>("POST", withReturn, {}, opts);
      this.withReturnSupported = true;
      return classifyChoreExecution(
        response?.ChoreExecuteStatusCode,
        response?.ErrorLogFile?.Filename,
      );
    } catch (error) {
      rethrowIfSystemic(error);
      // A build without the action answers 404 — and so does a chore that does
      // not exist. Measured on 11.8.02900.8: the two differ only in the error
      // PROSE ("resource can not be resolved on type 'Chore'" vs "can not be
      // found in collection of type 'Chore'"), and prose is not something this
      // codebase parses (a v11 server answers in the server's own language).
      //
      // So do not classify the 404 — retry on the plain action and let the
      // outcome say which it was. If the chore was missing, that call 404s the
      // same way and the error surfaces unchanged, one round-trip later. If it
      // runs, the chore existed, which proves the 404 was about the action:
      // record that and stop paying for the probe.
      //
      // Nothing can have executed here: a 404 means the request never reached
      // an action, so the retry cannot double-run the chore.
      if (
        error instanceof TM1Error &&
        error.code === TM1ErrorCode.NOT_FOUND &&
        this.withReturnSupported === null
      ) {
        const result = await this.executeWithoutStatus(plain, opts);
        this.withReturnSupported = false;
        return result;
      }
      throw error;
    }
  }

  /**
   * The statusless path: run the chore, report that nothing is known about how
   * it ended. Deliberately NOT `{success: true}` — that claim is what this
   * whole change exists to remove.
   */
  private async executeWithoutStatus(
    path: string,
    opts?: RequestOptions,
  ): Promise<ChoreResult> {
    await this.http.request<void>("POST", path, {}, opts);
    return {
      success: false,
      outcome: "indeterminate",
      choreErrorStatus: CHORE_STATUS_UNAVAILABLE,
      statusUnavailable: true,
    };
  }

  /**
   * Create a new chore.
   * POST /api/v1/Chores
   */
  async create(chore: ChoreCreate): Promise<void> {
    const body = {
      Name: chore.name,
      StartTime: chore.startTime,
      DSTSensitive: chore.dstSensitive,
      Active: chore.active,
      ExecutionMode: chore.executionMode,
      Frequency: frequencyDuration(chore.frequency),
      Tasks: chore.steps.map((step, idx) => ({
        Step: idx,
        "Process@odata.bind": `Processes('${enc(step.process)}')`,
        Parameters: step.parameters.map((p) => ({
          Name: p.name,
          Value: p.value,
        })),
      })),
    };
    await this.http.request<void>("POST", "/api/v1/Chores", body);
  }

  /**
   * Update an existing chore (partial update).
   * PATCH /api/v1/Chores('{name}')
   */
  async update(
    choreName: string,
    updates: {
      startTime?: string | undefined;
      active?: boolean | undefined;
      dstSensitive?: boolean | undefined;
      executionMode?: "SingleCommit" | "MultipleCommit" | undefined;
      frequency?: ChoreCreate["frequency"] | undefined;
      steps?: ChoreCreate["steps"] | undefined;
    },
  ): Promise<void> {
    const path = `/api/v1/Chores('${enc(choreName)}')`;
    const body: Record<string, unknown> = {};
    if (updates.startTime !== undefined) body.StartTime = updates.startTime;
    if (updates.active !== undefined) body.Active = updates.active;
    if (updates.dstSensitive !== undefined)
      body.DSTSensitive = updates.dstSensitive;
    if (updates.executionMode !== undefined)
      body.ExecutionMode = updates.executionMode;
    if (updates.frequency !== undefined) {
      body.Frequency = frequencyDuration(updates.frequency);
    }
    if (updates.steps !== undefined) {
      body.Tasks = updates.steps.map((step, idx) => ({
        Step: idx,
        "Process@odata.bind": `Processes('${enc(step.process)}')`,
        Parameters: step.parameters.map((p) => ({
          Name: p.name,
          Value: p.value,
        })),
      }));
    }
    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Delete a chore.
   * DELETE /api/v1/Chores('{name}')
   */
  async delete(choreName: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Chores('${enc(choreName)}')`,
    );
  }
}
