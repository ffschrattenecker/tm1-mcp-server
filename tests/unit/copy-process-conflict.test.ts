import { describe, it, expect } from "vitest";
import { registerCopyProcess } from "../../src/tools/ti-development/copy-process.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { captureParsedTool } from "../helpers/client-harness.js";

function call(existing: Set<string>, copies: unknown[][]) {
  const h = captureParsedTool(registerCopyProcess, {
    processes: {
      exists: async (n: string) => existing.has(n),
      copy: async (...a: unknown[]) => void copies.push(a),
    },
  } as unknown as TM1Client);
  return (args: Record<string, unknown>) => h(args);
}

describe("tm1_copy_process", () => {
  it("fails with CONFLICT on an existing target and copies nothing", async () => {
    const copies: unknown[][] = [];
    await expect(
      call(new Set(["B"]), copies)({ sourceName: "A", targetName: "B" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(copies).toEqual([]);
  });

  it("copies onto a free name", async () => {
    const copies: unknown[][] = [];
    await call(new Set(), copies)({ sourceName: "A", targetName: "B" });
    expect(copies).toEqual([["A", "B"]]);
  });
});
