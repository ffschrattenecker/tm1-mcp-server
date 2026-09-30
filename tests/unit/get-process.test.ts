import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerGetProcess } from "../../src/tools/ti-development/get-process.js";
import { captureTool, type ToolCb } from "../helpers/client-harness.js";

function capture(processes: Partial<TM1Client["processes"]>): {
  cb: ToolCb;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {
    getCode: 0,
    getParameters: 0,
    getVariables: 0,
    getDataSource: 0,
    getDeployMeta: 0,
  };
  const counting = new Proxy(processes, {
    get(target, prop: string) {
      const orig = (target as Record<string, unknown>)[prop];
      if (typeof orig === "function") {
        return async (...args: unknown[]) => {
          if (prop in calls) calls[prop] += 1;
          return (orig as (...a: unknown[]) => unknown)(...args);
        };
      }
      return orig;
    },
  });
  const { cb } = captureTool(
    registerGetProcess,
    contractCheckedClient({ processes: counting } as unknown as TM1Client),
  );
  return { cb, calls };
}

const stubs = {
  getCode: async () => ({ prolog: "p", metadata: "m", data: "d", epilog: "e" }),
  getParameters: async () => [
    { name: "pMonth", type: "String" as const, defaultValue: "Jan" },
  ],
  getVariables: async () => [
    { name: "v1", type: "Numeric" as const, position: 1 },
  ],
  getVariableLayout: async () => ({
    variables: [{ name: "v1", type: "Numeric" as const, position: 1 }],
    ignoredColumns: [],
  }),
  getDataSource: async () => ({ type: "None" as const }),
  getDeployMeta: async () => ({ hasSecurityAccess: true }),
};

describe("tm1_get_process", () => {
  it("returns all parts with upsert field names by default", async () => {
    const { cb } = capture(stubs);
    const payload = JSON.parse(
      (await cb({ processName: "proc.a" }, {})).content[0].text,
    );
    expect(payload).toMatchObject({
      name: "proc.a",
      prolog: "p",
      metadata: "m",
      data: "d",
      epilog: "e",
      parameters: [{ name: "pMonth" }],
      variables: [{ name: "v1" }],
      dataSource: { type: "None" },
      hasSecurityAccess: true,
    });
  });

  it("skips a part's service call when its include-flag is false", async () => {
    const { cb, calls } = capture(stubs);
    const payload = JSON.parse(
      (
        await cb(
          {
            processName: "proc.a",
            includeParameters: false,
            includeVariables: false,
            includeDataSource: false,
            includeSecurityAccess: false,
          },
          {},
        )
      ).content[0].text,
    );
    expect(payload.parameters).toBeUndefined();
    expect(payload.variables).toBeUndefined();
    expect(payload.dataSource).toBeUndefined();
    expect(payload.hasSecurityAccess).toBeUndefined();
    expect(payload.prolog).toBe("p");
    expect(calls.getParameters).toBe(0);
    expect(calls.getVariables).toBe(0);
    expect(calls.getDataSource).toBe(0);
    expect(calls.getDeployMeta).toBe(0);
    expect(calls.getCode).toBe(1);
  });

  it("masks datasource password when maskSecrets (default)", async () => {
    const { cb } = capture({
      ...stubs,
      getDataSource: async () => ({ type: "ODBC", password: "hunter2" }),
    });
    const payload = JSON.parse(
      (await cb({ processName: "proc.a" }, {})).content[0].text,
    );
    expect(payload.dataSource.password).toBe("***");
  });
});
