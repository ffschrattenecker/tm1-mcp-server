// Subset writes, pinned to what TM1 11.8 and 12.5 did when measured: a PATCH
// that binds Elements appends to the list, `Expression: ""` next to a bind is
// refused, and only dropping every reference first replaces the list.
import { describe, it, expect, vi } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { SubsetService } from "../../src/tm1-client/services/subset-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const BASE = "/api/v1/Dimensions('D')/Hierarchies('D')";
const bindOf = (...names: string[]) =>
  names.map((n) => `Dimensions('D')/Hierarchies('D')/Elements('${n}')`);

function makeService(
  current: { Expression?: string; Elements: string[] },
  failPatch?: (body: Record<string, unknown>) => boolean,
) {
  const calls: Call[] = [];
  const http = contractCheckedHttp({
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "GET")
        return {
          Name: "S",
          Expression: current.Expression,
          Elements: current.Elements.map((Name) => ({ Name })),
        };
      if (method === "PATCH" && failPatch?.(body as Record<string, unknown>))
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: "'Nope' can not be found in collection of type 'Element'.",
          httpStatus: 404,
        });
      return undefined;
    }),
  } as unknown as TM1HttpClient);
  return { svc: new SubsetService(http), calls };
}

describe("SubsetService.update", () => {
  it("replaces a static list: drop every reference, then bind the new ones", async () => {
    const { svc, calls } = makeService({ Elements: ["A", "B"] });
    await svc.update("D", "D", "S", { elements: ["C", "A"] });

    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      {
        method: "DELETE",
        path: `${BASE}/Subsets('S')/Elements/$ref`,
        body: undefined,
      },
      {
        method: "PATCH",
        path: `${BASE}/Subsets('S')`,
        body: { "Elements@odata.bind": bindOf("C", "A") },
      },
    ]);
  });

  it("never sends Expression next to a bind, which TM1 refuses", async () => {
    const { svc, calls } = makeService({
      Expression: "{[D].[A]}",
      Elements: ["A"],
    });
    await svc.update("D", "D", "S", { elements: ["B"] });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).not.toHaveProperty("Expression");
  });

  it("empties the list for elements: [] without a second call", async () => {
    const { svc, calls } = makeService({ Elements: ["A"] });
    await svc.update("D", "D", "S", { elements: [] });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });

  it("writes the old static list back when the new one names an unknown element", async () => {
    const { svc, calls } = makeService({ Elements: ["A", "B"] }, (b) =>
      JSON.stringify(b).includes("Nope"),
    );
    await expect(
      svc.update("D", "D", "S", { elements: ["Nope"] }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.NOT_FOUND });

    const last = calls.at(-1)!;
    expect(last.method).toBe("PATCH");
    expect(last.body).toEqual({ "Elements@odata.bind": bindOf("A", "B") });
  });

  it("writes the old MDX back when the subset was dynamic", async () => {
    const { svc, calls } = makeService(
      { Expression: "{[D].[A]}", Elements: ["A"] },
      (b) => JSON.stringify(b).includes("Nope"),
    );
    await expect(
      svc.update("D", "D", "S", { elements: ["Nope"] }),
    ).rejects.toThrow();
    expect(calls.at(-1)!.body).toEqual({ Expression: "{[D].[A]}" });
  });

  it("says so when the restore fails too", async () => {
    const { svc } = makeService({ Elements: ["A"] }, () => true);
    await expect(
      svc.update("D", "D", "S", { elements: ["Nope"] }),
    ).rejects.toThrow(/emptied and could not be restored/);
  });

  it("sets an expression with one PATCH", async () => {
    const { svc, calls } = makeService({ Elements: [] });
    await svc.update("D", "D", "S", { expression: "{[D].[B]}", alias: "x" });
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: `${BASE}/Subsets('S')`,
        body: { Alias: "x", Expression: "{[D].[B]}" },
      },
    ]);
  });

  it("refuses expression and elements together", async () => {
    const { svc, calls } = makeService({ Elements: [] });
    await expect(
      svc.update("D", "D", "S", { expression: "{}", elements: ["A"] }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.VALIDATION_ERROR });
    expect(calls).toHaveLength(0);
  });

  it("refuses an update with nothing in it", async () => {
    const { svc, calls } = makeService({ Elements: [] });
    await expect(svc.update("D", "D", "S", {})).rejects.toMatchObject({
      code: TM1ErrorCode.VALIDATION_ERROR,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("SubsetService private subsets", () => {
  it("creates, updates and deletes under PrivateSubsets", async () => {
    const { svc, calls } = makeService({ Elements: ["A"] });
    await svc.create("D", "D", { name: "S", elements: ["A"] }, true);
    await svc.update("D", "D", "S", { elements: ["B"] }, true);
    await svc.delete("D", "D", "S", true);

    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      `POST ${BASE}/PrivateSubsets`,
      `GET ${BASE}/PrivateSubsets('S')`,
      `DELETE ${BASE}/PrivateSubsets('S')/Elements/$ref`,
      `PATCH ${BASE}/PrivateSubsets('S')`,
      `DELETE ${BASE}/PrivateSubsets('S')`,
    ]);
  });
});
