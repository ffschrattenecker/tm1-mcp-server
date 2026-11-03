// ProcessService reads: data source listing, git header and deploy metadata,
// and the one-request variables fan-in used by tm1_audit_complexity.
import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ProcessService } from "../../src/tm1-client/services/process-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

// `contract` runs the stub's responses through the recorded wire contracts.
function makeService(
  respond: (path: string) => unknown,
  { contract = false }: { contract?: boolean } = {},
) {
  const calls: Call[] = [];
  const http = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return respond(path);
    }),
  } as unknown as TM1HttpClient;
  const svc = new ProcessService(contract ? contractCheckedHttp(http) : http);
  return { svc, calls };
}

describe("ProcessService.listDataSources", () => {
  it("selects only the fields it returns, never the credentials", async () => {
    const { svc, calls } = makeService(() => ({
      value: [
        {
          Name: "Load",
          DataSource: { Type: "TM1CubeView", view: "Actuals" },
        },
      ],
    }));
    expect(await svc.listDataSources()).toEqual([
      { name: "Load", type: "TM1CubeView", view: "Actuals" },
    ]);
    // A bare DataSource select returns the whole complex type: password,
    // userName and the ODBC query included.
    expect(calls[0].path).not.toMatch(/DataSource(?!\/)/);
  });
});

describe("getGitHeader", () => {
  it("fills lists TM1 leaves out with [] so export and import agree", async () => {
    const { svc } = makeService(() => ({
      Name: "P",
      DataSource: { Type: "None" },
    }));
    const h = await svc.getGitHeader("P");
    expect(h.Parameters).toEqual([]);
    expect(h.Variables).toEqual([]);
  });

  it("does not retry on a v11 denial, which also arrives as HTTP 400", async () => {
    const denied = new TM1Error({
      code: TM1ErrorCode.PERMISSION_DENIED,
      message: "ObjectSecurityNoReadRights",
      httpStatus: 400,
    });
    const { svc, calls } = makeService(() => {
      throw denied;
    });
    await expect(svc.getGitHeader("P")).rejects.toBe(denied);
    expect(calls).toHaveLength(1);
  });
});

describe("updateDeployMeta", () => {
  it("sends HasSecurityAccess and UIData in one PATCH, leaving out what is undefined", async () => {
    const { svc, calls } = makeService(() => undefined);
    await svc.updateDeployMeta("P", { hasSecurityAccess: true, uiData: "u" });
    await svc.updateDeployMeta("P", { uiData: "u" });
    expect(calls.map((c) => c.body)).toEqual([
      { HasSecurityAccess: true, UIData: "u" },
      { UIData: "u" },
    ]);
  });
});

// getAllVariables replaces a per-process fan-out with one request. Variables is
// a complex-typed property, not a navigation, so the process list carries it.
describe("ProcessService.getAllVariables", () => {
  const variables = (rows: Array<Record<string, unknown>>) =>
    makeService(() => ({ value: rows }), { contract: true });

  it("asks once, selecting Variables alongside the name", async () => {
    const { svc, calls } = variables([]);
    await svc.getAllVariables();

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("$select=Name,Variables");
    // Control objects stay out unless asked for, same as getAllCode.
    expect(calls[0].path).toContain("not startswith(Name,'}')");
  });

  it("includes control processes on request", async () => {
    const { svc, calls } = variables([]);
    await svc.getAllVariables(true);
    expect(calls[0].path).not.toContain("startswith");
  });

  it("maps each process to its variables", async () => {
    const { svc } = variables([
      {
        Name: "Load.Sales",
        Variables: [
          { Name: "vCustomer", Type: "String", Position: 1 },
          { Name: "vAmount", Type: "Numeric", Position: 2 },
        ],
      },
      { Name: "Util.NoVars", Variables: [] },
    ]);

    const byProcess = await svc.getAllVariables();

    expect(byProcess.get("Load.Sales")).toEqual([
      { name: "vCustomer", type: "String", position: 1 },
      { name: "vAmount", type: "Numeric", position: 2 },
    ]);
    expect(byProcess.get("Util.NoVars")).toEqual([]);
  });

  it("carries the byte offsets of a fixed-width source when present", async () => {
    const { svc } = variables([
      {
        Name: "Load.Fixed",
        Variables: [
          {
            Name: "vId",
            Type: "String",
            Position: 1,
            StartByte: 0,
            EndByte: 7,
          },
        ],
      },
    ]);
    expect((await svc.getAllVariables()).get("Load.Fixed")).toEqual([
      { name: "vId", type: "String", position: 1, startByte: 0, endByte: 7 },
    ]);
  });

  it("treats an absent Variables array as no variables", async () => {
    // $select on a complex property omits it entirely when the process has
    // none, rather than sending an empty array.
    const { svc } = variables([{ Name: "Util.Bare" }]);
    expect((await svc.getAllVariables()).get("Util.Bare")).toEqual([]);
  });

  it("classifies any non-Numeric type as String, as getVariables does", async () => {
    const { svc } = variables([
      { Name: "P", Variables: [{ Name: "v", Type: "Unknown", Position: 1 }] },
    ]);
    expect((await svc.getAllVariables()).get("P")?.[0]?.type).toBe("String");
  });
});
