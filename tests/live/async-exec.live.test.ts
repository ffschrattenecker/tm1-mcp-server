// TI runs as TM1 async operations (Prefer: respond-async + /_async polling).
//
// What this pins down, on the real server:
//   - a run outlasting the per-request timeout completes, because no single
//     request is held open for it
//   - aborting the caller's signal cancels the run on the server (DELETE
//     /_async) and its cube write is rolled back
//   - running out of timeoutMs only stops the waiting: the run goes on and
//     commits
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cellValue,
  createCube,
  createDimension,
  dropIfExists,
  getHarness,
  LIVE_ENABLED,
  restGet,
  SANDBOX,
  seg,
  type LiveHarness,
} from "./harness.js";
import { loadConfig } from "../../src/config.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";
import { createLogger } from "../../src/logger.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

const PREFIX = `${SANDBOX}_ASYNC`;
const DIM_A = `${PREFIX}_DA`;
const DIM_B = `${PREFIX}_DB`;
const CUBE = `${PREFIX}_CUBE`;
const PROC = `${PREFIX}_SLEEP`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE_ENABLED)("async TI execution", () => {
  let h: LiveHarness;

  const cell = (element: string): Promise<unknown> =>
    cellValue(h, CUBE, [DIM_A, DIM_B], [element, "F1"]);
  const cleanup = async () => {
    await dropIfExists(h, seg("Processes", PROC));
    await dropIfExists(h, seg("Cubes", CUBE));
    for (const d of [DIM_A, DIM_B]) {
      await dropIfExists(h, seg("Dimensions", d));
    }
  };
  const run = (el: string, ms: number) => ({ pEl: el, pVal: 7, pMs: ms });

  beforeAll(async () => {
    h = await getHarness();
    await cleanup();
    await createDimension(h, DIM_A, ["LONG", "CANCEL", "TIMEOUT", "TOOL"]);
    await createDimension(h, DIM_B, ["F1"]);
    await createCube(h, CUBE, [DIM_A, DIM_B]);
    // Write FIRST, then sleep: whether the write survives says whether the
    // run committed.
    await h.ok("tm1_upsert_process", {
      processName: PROC,
      parameters: [
        { name: "pEl", type: "String", defaultValue: "LONG" },
        { name: "pVal", type: "Numeric", defaultValue: 0 },
        { name: "pMs", type: "Numeric", defaultValue: 0 },
      ],
      prolog: `CellPutN(pVal, '${CUBE}', pEl, 'F1');\r\nSleep(pMs);\r\n`,
      mode: "upsert",
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("completes a run that outlasts the per-request timeout", async () => {
    // A client whose every single request gives up after 1s. The run takes 3s.
    const config = { ...loadConfig(), requestTimeoutMs: 1000 };
    const logger = createLogger({ logLevel: "error" });
    const client = new TM1Client(
      config,
      new SessionManager(config, logger),
      logger,
    );
    await client.connect();

    const result = await client.processes.execute(PROC, run("LONG", 3000));

    expect(result.success).toBe(true);
    expect(await cell("LONG")).toBe(7);
  }, 60_000);

  it("cancels the run on the server when the caller aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 2000);

    await expect(
      h.client.processes.execute(PROC, run("CANCEL", 20_000), {
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // The run would take 20s. Give the cancel a moment, then check it is gone
    // well before that — and that its write was rolled back.
    await sleep(2000);
    const running = await restGet<unknown[]>(
      h,
      h.client.version === 12 ? "Jobs" : "Threads",
    );
    expect(JSON.stringify(running)).not.toContain(PROC);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await cell("CANCEL")).not.toBe(7);
  }, 60_000);

  it("stops waiting at timeoutMs but lets the run commit", async () => {
    const err = await h.client.processes
      .execute(PROC, run("TIMEOUT", 5000), { timeoutMs: 1500 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).code).toBe(TM1ErrorCode.LOCK_TIMEOUT);
    await sleep(6000);
    expect(await cell("TIMEOUT")).toBe(7);
  }, 60_000);

  it("runs through tm1_execute_process", async () => {
    const r = await h.ok("tm1_execute_process", {
      processName: PROC,
      parameters: run("TOOL", 1500),
      confirm: PROC,
    });
    expect(r.json?.success).toBe(true);
    expect(await cell("TOOL")).toBe(7);
  }, 60_000);
});
