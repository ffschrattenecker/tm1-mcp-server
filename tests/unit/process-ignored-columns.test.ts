// A datasource column set to "Ignore" is invisible in `Variables`.
//
// TM1 drops it from that list entirely and records the fact only in
// `VariablesUIData` — a property neither version declares in $metadata, so it
// arrives only when named in `$select`. Everything here pins that: the
// encoding, the single request that fetches both, and the write paths that
// used to lose the flag (copy, .pro and git import).
import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ProcessService } from "../../src/tm1-client/services/process-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import {
  ignoredColumnsOf,
  parseVariableColumns,
} from "../../src/lib/variables-ui-data.js";

// Shape TM1 writes, measured on 11.8 and 12.5 (and in 396 columns across the
// .pro corpus): fields separated by form feed, ColType 1165 = Ignore.
const IGNORED = "IgnoredInputVarName=vsOld\fVarType=32\fColType=1165\f";
const NORMAL_STRING = "VarType=32\fColType=827\f";
const NORMAL_NUMERIC = "VarType=33\fColType=827\f";

interface Stub {
  svc: ProcessService;
  paths: string[];
  bodies: unknown[];
}

function makeService(respond: (method: string, path: string) => unknown): Stub {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const http = contractCheckedHttp({
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      paths.push(path);
      bodies.push(body);
      return respond(method, path);
    }),
  } as unknown as TM1HttpClient);
  return { svc: new ProcessService(http), paths, bodies };
}

describe("VariablesUIData encoding", () => {
  it("reads one column per entry, 1-based, ignore flag from ColType", () => {
    expect(
      parseVariableColumns([IGNORED, NORMAL_STRING, NORMAL_NUMERIC]),
    ).toEqual([
      { position: 1, ignored: true, ignoredName: "vsOld" },
      { position: 2, ignored: false },
      { position: 3, ignored: false },
    ]);
  });

  it("keeps only the ignored columns for tool output", () => {
    expect(ignoredColumnsOf([NORMAL_STRING, IGNORED])).toEqual([
      { position: 2, name: "vsOld" },
    ]);
  });

  it("treats the ColType, not the remembered name, as the signal", () => {
    expect(ignoredColumnsOf(["VarType=32\fColType=1165\f"])).toEqual([
      { position: 1 },
    ]);
  });

  it("reports nothing when the server sent no UI data", () => {
    expect(ignoredColumnsOf(undefined)).toEqual([]);
    expect(parseVariableColumns(undefined)).toEqual([]);
  });
});

describe("ProcessService.getVariableLayout", () => {
  it("fetches variables and UI data in one request", async () => {
    const { svc, paths } = makeService(() => ({
      Name: "Load.Sales",
      Variables: [
        { Name: "vsCustomer", Type: "String", Position: 2 },
        { Name: "vnAmount", Type: "Numeric", Position: 3 },
      ],
      VariablesUIData: [IGNORED, NORMAL_STRING, NORMAL_NUMERIC],
    }));

    const layout = await svc.getVariableLayout("Load.Sales");

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("$select=Variables,VariablesUIData");
    expect(layout.variables).toEqual([
      { name: "vsCustomer", type: "String", position: 2 },
      { name: "vnAmount", type: "Numeric", position: 3 },
    ]);
    // Column 1 is ignored — which is why the variables start at position 2.
    expect(layout.ignoredColumns).toEqual([{ position: 1, name: "vsOld" }]);
    expect(layout.variablesUIData).toEqual([
      IGNORED,
      NORMAL_STRING,
      NORMAL_NUMERIC,
    ]);
  });

  it("getVariables keeps returning the plain list", async () => {
    const { svc } = makeService(() => ({
      Variables: [{ Name: "vsCustomer", Type: "String", Position: 1 }],
      VariablesUIData: [NORMAL_STRING],
    }));
    expect(await svc.getVariables("Load.Sales")).toEqual([
      { name: "vsCustomer", type: "String", position: 1 },
    ]);
  });

  it("falls back to the plain collection when the $select is refused", async () => {
    const { svc, paths } = makeService((_method, path) => {
      if (path.includes("$select")) {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "bad query option",
          httpStatus: 400,
        });
      }
      return { value: [{ Name: "vsCustomer", Type: "String", Position: 1 }] };
    });

    const layout = await svc.getVariableLayout("Load.Sales");

    expect(paths[1]).toBe("/api/v1/Processes('Load.Sales')/Variables");
    expect(layout.variables).toHaveLength(1);
    // No UI data means no claim about ignored columns, not "there are none".
    expect(layout.ignoredColumns).toEqual([]);
    expect(layout.variablesUIData).toBeUndefined();
  });

  it("does not turn an auth failure into a downgrade", async () => {
    const { svc, paths } = makeService(() => {
      throw new TM1Error({
        code: TM1ErrorCode.AUTH_FAILED,
        message: "session expired",
      });
    });

    await expect(svc.getVariableLayout("Load.Sales")).rejects.toThrow(
      "session expired",
    );
    expect(paths).toHaveLength(1);
  });
});

describe("ProcessService.updateVariables", () => {
  const vars = [{ name: "vsCustomer", type: "String" as const, position: 2 }];

  it("leaves the stored UI data alone when none is supplied", async () => {
    const { svc, bodies } = makeService(() => undefined);
    await svc.updateVariables("Load.Sales", vars);
    expect(bodies[0]).not.toHaveProperty("VariablesUIData");
  });

  it("writes the supplied column layout back", async () => {
    const { svc, bodies } = makeService(() => undefined);
    await svc.updateVariables("Load.Sales", vars, [IGNORED, NORMAL_STRING]);
    expect(bodies[0]).toMatchObject({
      VariablesUIData: [IGNORED, NORMAL_STRING],
    });
  });
});

describe("ProcessService.copy", () => {
  it("carries the undeclared UI properties to the target", async () => {
    const { svc, paths, bodies } = makeService((method, path) => {
      if (method === "GET" && path.includes("$select")) {
        return {
          UIData: "CubeAction=1511\f",
          VariablesUIData: [IGNORED, NORMAL_STRING],
        };
      }
      if (method === "GET") {
        return {
          "@odata.context": "ctx",
          "@odata.etag": "etag",
          Name: "Load.Sales",
          PrologProcedure: "",
          Variables: [{ Name: "vsCustomer", Type: "String", Position: 2 }],
        };
      }
      return undefined;
    });

    await svc.copy("Load.Sales", "Load.Sales.Copy");

    // Plain GET, UI-data GET, then the POST — the second request is the whole
    // point: without it the copy loses every ignored column.
    expect(paths).toHaveLength(3);
    const posted = bodies[2] as Record<string, unknown>;
    expect(posted.Name).toBe("Load.Sales.Copy");
    expect(posted.VariablesUIData).toEqual([IGNORED, NORMAL_STRING]);
    expect(posted.UIData).toBe("CubeAction=1511\f");
    expect(posted["@odata.etag"]).toBeUndefined();
  });

  it("copies anyway when the server will not serve the UI properties", async () => {
    const { svc, bodies } = makeService((method, path) => {
      if (method === "GET" && path.includes("$select")) {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "bad query option",
          httpStatus: 400,
        });
      }
      if (method === "GET") return { Name: "Load.Sales" };
      return undefined;
    });

    await svc.copy("Load.Sales", "Load.Sales.Copy");
    const posted = bodies[2] as Record<string, unknown>;
    expect(posted.Name).toBe("Load.Sales.Copy");
    expect(posted).not.toHaveProperty("VariablesUIData");
  });
});
