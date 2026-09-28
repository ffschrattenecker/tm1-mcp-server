import { describe, expect, it } from "vitest";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerDiffProcesses } from "../../src/tools/ti-development/diff-processes.js";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { peerRunner } from "../helpers/peer-tool.js";

function client(prologByProcess: Record<string, string>): TM1Client {
  return contractCheckedClient({
    processes: {
      getCode: async (name: string) => ({
        prolog: prologByProcess[name] ?? "",
        metadata: "",
        data: "",
        epilog: "",
      }),
      getParameters: async () => [],
      getVariableLayout: async () => ({ variables: [], ignoredColumns: [] }),
      getDataSource: async () => ({ type: "None" }),
    },
  } as unknown as TM1Client);
}

interface Result {
  processA: string;
  processB: string;
  connectionA: string;
  connectionB: string;
  identical: boolean;
  tabs: { prolog: { identical: boolean; hunks: unknown[] } };
}

describe("tm1_diff_processes across connections", () => {
  const run = peerRunner(registerDiffProcesses, {
    dev: client({ Load: "nX = 2;" }),
    prod: client({ Load: "nX = 1;" }),
  });

  it("diffs the same process on two connections when processB is omitted", async () => {
    const r = await run<Result>({
      processA: "Load",
      connection: "prod",
      connectionB: "dev",
    });
    expect(r).toMatchObject({
      processA: "Load",
      processB: "Load",
      connectionA: "prod",
      connectionB: "dev",
      identical: false,
    });
    expect(r.tabs.prolog.hunks).toHaveLength(1);
  });

  it("stays on one connection without connectionB", async () => {
    const r = await run<Result>({ processA: "Load", connection: "dev" });
    expect(r.connectionB).toBe("dev");
    expect(r.identical).toBe(true);
  });
});
