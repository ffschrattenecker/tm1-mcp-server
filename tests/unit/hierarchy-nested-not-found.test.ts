import { describe, it, expect } from "vitest";
import { HierarchyService } from "../../src/tm1-client/services/hierarchy-service.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

describe("HierarchyService nested NOT_FOUND", () => {
  it("reports the endpoint without the kilobyte-long $expand query", async () => {
    const request = async (_method: string, path: string) => {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: "not found",
        httpStatus: 404,
        endpoint: path,
      });
    };
    const svc = new HierarchyService({
      request,
    } as unknown as ConstructorParameters<typeof HierarchyService>[0]);

    const err = await svc
      .getDescendants("D", "D", "Nope", { depth: 20 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TM1Error);
    expect((err as TM1Error).code).toBe(TM1ErrorCode.NOT_FOUND);
    expect((err as TM1Error).endpoint).toBe(
      "/api/v1/Dimensions('D')/Hierarchies('D')/Elements('Nope')",
    );
  });
});
