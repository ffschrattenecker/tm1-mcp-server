import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { CubeService } from "../../src/tm1-client/services/cube-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// `CubeService.exists()` is the structural answer to "does this server have
// }StatsByCube?" — the question the cube-stats fetcher used to infer from the
// text of a failed MDX query, which is wrong on any server whose version or
// locale words that text differently (v11 en, v12, and v11 de each phrase it
// differently — see cube-stats-unavailable.test.ts).
function makeHttp(
  requestImpl: (method: string, path: string) => Promise<unknown>,
): TM1HttpClient {
  return contractCheckedHttp({
    request: vi.fn(requestImpl),
  } as unknown as TM1HttpClient);
}

describe("request shape: CubeService.exists", () => {
  it("doubles an embedded apostrophe per OData literal rules", async () => {
    const request = vi.fn(async () => ({ Name: "x" }));
    const cubes = new CubeService(makeHttp(request));

    await expect(cubes.exists("O'Brien")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/Cubes('O''Brien')?$select=Name",
    );
  });
});

describe("CubeService.exists", () => {
  it("404 → false", async () => {
    const request = vi.fn(async () => {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: "Resource not found",
        httpStatus: 404,
      });
    });
    const cubes = new CubeService(makeHttp(request));
    await expect(cubes.exists("}StatsByCube")).resolves.toBe(false);
  });

  it("rethrows a denial — 'you may not look' is not 'it is not there'", async () => {
    const denied = new TM1Error({
      code: TM1ErrorCode.PERMISSION_DENIED,
      message: "ObjectSecurityNoReadRights",
      httpStatus: 400,
    });
    const request = vi.fn(async () => {
      throw denied;
    });
    const cubes = new CubeService(makeHttp(request));
    await expect(cubes.exists("}StatsByCube")).rejects.toBe(denied);
  });

  it("rethrows any other failure rather than reporting absence", async () => {
    const boom = new Error("connection reset");
    const request = vi.fn(async () => {
      throw boom;
    });
    const cubes = new CubeService(makeHttp(request));
    await expect(cubes.exists("Sales")).rejects.toBe(boom);
  });
});

describe("skipCheck: the directive, not a comment that names it", () => {
  const rules = "# no SKIPCHECK here\n['A'] = N: 1;";

  it("getRules reads '# no SKIPCHECK' as no directive", async () => {
    const cubes = new CubeService(makeHttp(async () => ({ value: rules })));
    expect((await cubes.getRules("Sales")).skipCheck).toBe(false);
  });

  it("getAllRules reads '# no SKIPCHECK' as no directive", async () => {
    const cubes = new CubeService(
      makeHttp(async () => ({ value: [{ Name: "Sales", Rules: rules }] })),
    );
    const [c] = await cubes.getAllRules(false);
    expect(c!.skipCheck).toBe(false);
  });

  it("getAllRules reads a SKIPCHECK; line as the directive", async () => {
    const cubes = new CubeService(
      makeHttp(async () => ({
        value: [{ Name: "Sales", Rules: "SKIPCHECK;\n['A'] = N: 1;" }],
      })),
    );
    const [c] = await cubes.getAllRules(false);
    expect(c!.skipCheck).toBe(true);
  });
});
