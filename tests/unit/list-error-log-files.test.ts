import { describe, expect, it } from "vitest";
import { ServerService } from "../../src/tm1-client/services/server-service.js";

function serviceReturning(filenames: string[]) {
  const paths: string[] = [];
  const service = new ServerService({
    request: async (_method: string, path: string) => {
      paths.push(path);
      return { value: filenames.map((Filename) => ({ Filename })) };
    },
  } as never);
  return { service, paths };
}

describe("ServerService.listErrorLogFiles", () => {
  it("lets TM1 sort and cap the listing when nothing else filters", async () => {
    const { service, paths } = serviceReturning([]);
    await service.listErrorLogFiles({ top: 5 });
    expect(paths[0]).toBe(
      "/api/v1/ErrorLogFiles?$orderby=Filename desc&$top=5",
    );
  });

  it("prefilters by process name on the server, matches exactly on the client", async () => {
    const { service, paths } = serviceReturning([
      "TM1ProcessError_20260101120000_1_Load.Sales_ab12.log",
      "TM1ProcessError_20260101110000_2_Load.SalesPlan_cd34.log",
    ]);
    const files = await service.listErrorLogFiles({
      processName: "Load.Sales",
      top: 5,
    });
    expect(paths[0]).toBe(
      "/api/v1/ErrorLogFiles?$orderby=Filename desc&$filter=contains(tolower(Filename),'load.sales')",
    );
    expect(files.map((f) => f.filename)).toEqual([
      "TM1ProcessError_20260101120000_1_Load.Sales_ab12.log",
    ]);
  });

  it("does not cap server-side when since filters on the client", async () => {
    const { service, paths } = serviceReturning([]);
    await service.listErrorLogFiles({ since: "2026-01-01", top: 5 });
    expect(paths[0]).not.toContain("$top");
  });

  it("escapes a quote in the process name", async () => {
    const { service, paths } = serviceReturning([]);
    await service.listErrorLogFiles({ processName: "O'Load" });
    expect(paths[0]).toContain("'o''load'");
  });
});
