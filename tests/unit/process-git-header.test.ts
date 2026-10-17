// getGitHeader feeds the git .json; updateDeployMeta writes back what it carries.
import { describe, it, expect, vi } from "vitest";
import { ProcessService } from "../../src/tm1-client/services/process-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

function makeService(respond: (path: string) => unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return respond(path);
    }),
  } as unknown as TM1HttpClient;
  return { svc: new ProcessService(http), calls };
}

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
