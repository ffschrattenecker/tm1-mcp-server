import { describe, it, expect } from "vitest";
import { AsyncOrigins } from "../helpers/wire-contract.js";

const h = (entries: Record<string, string>) => new Headers(entries);

describe("AsyncOrigins", () => {
  it("attributes the final poll to the request that started the run", () => {
    const o = new AsyncOrigins();
    const post = "/api/v1/Processes('p')/tm1.ExecuteWithReturn";
    const poll = "/api/v1/_async('abc')";

    expect(
      o.classify("POST", post, 202, h({ location: "../_async('abc')" })),
    ).toEqual({
      base: "POST /api/v1/Processes('*')/tm1.ExecuteWithReturn",
      status: 202,
    });
    // Still running: the poll is its own, empty response.
    expect(
      o.classify("GET", poll, 202, h({ location: "_async('abc')" })).base,
    ).toBe("GET /api/v1/_async('*')");
    // Done: the request's key, the asyncresult status.
    expect(
      o.classify("GET", poll, 200, h({ asyncresult: "500 Internal Error" })),
    ).toEqual({
      base: "POST /api/v1/Processes('*')/tm1.ExecuteWithReturn",
      status: 500,
    });
  });

  it("leaves a poll it never saw start under its own key", () => {
    const o = new AsyncOrigins();
    expect(o.classify("GET", "/api/v1/_async('zzz')", 200, h({}))).toEqual({
      base: "GET /api/v1/_async('*')",
      status: 200,
    });
  });
});
