import { describe, it, expect } from "vitest";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

function serviceWith(respond: (path: string) => unknown) {
  const paths: string[] = [];
  const http = {
    request: async (_m: string, path: string) => {
      paths.push(path);
      return respond(path);
    },
  };
  const svc = new ElementService(
    http as unknown as ConstructorParameters<typeof ElementService>[0],
    {} as unknown as ConstructorParameters<typeof ElementService>[1],
  );
  return { svc, paths };
}

describe("ElementService.getType", () => {
  it("reads one element by key with the minimal projection", async () => {
    const { svc, paths } = serviceWith(() => ({
      Name: "North America",
      Type: "Consolidated",
    }));
    expect(await svc.getType("Region", "Region", "o'na")).toEqual({
      name: "North America",
      type: "Consolidated",
    });
    expect(paths).toEqual([
      "/api/v1/Dimensions('Region')/Hierarchies('Region')/Elements('o''na')?$select=Name,Type",
    ]);
  });

  it("returns null when the element does not resolve", async () => {
    const { svc } = serviceWith(() => {
      throw new TM1Error({ code: TM1ErrorCode.NOT_FOUND, message: "404" });
    });
    expect(await svc.getType("Region", "Region", "Nope")).toBeNull();
  });

  it("rethrows anything else — a denial is not 'missing'", async () => {
    const { svc } = serviceWith(() => {
      throw new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message: "no",
      });
    });
    await expect(svc.getType("Region", "Region", "x")).rejects.toThrow("no");
  });
});
