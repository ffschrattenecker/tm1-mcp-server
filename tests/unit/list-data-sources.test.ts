import { describe, expect, it } from "vitest";
import { ProcessService } from "../../src/tm1-client/services/process-service.js";

describe("ProcessService.listDataSources", () => {
  it("selects only the fields it returns, never the credentials", async () => {
    const paths: string[] = [];
    const service = new ProcessService({
      request: async (_method: string, path: string) => {
        paths.push(path);
        return {
          value: [
            {
              Name: "Load",
              DataSource: { Type: "TM1CubeView", view: "Actuals" },
            },
          ],
        };
      },
    } as never);
    expect(await service.listDataSources()).toEqual([
      { name: "Load", type: "TM1CubeView", view: "Actuals" },
    ]);
    // A bare DataSource select returns the whole complex type: password,
    // userName and the ODBC query included.
    expect(paths[0]).not.toMatch(/DataSource(?!\/)/);
  });
});
