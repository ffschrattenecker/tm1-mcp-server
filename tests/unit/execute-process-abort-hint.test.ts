import { describe, it, expect } from "vitest";
import { abortHint } from "../../src/tools/ti-development/execute-process.js";

describe("abortHint", () => {
  it("points jobs on v12", () => {
    const h = abortHint(12);
    expect(h).toContain("tm1_rest_read Jobs");
    expect(h).toContain("Jobs('id')/tm1.Cancel");
    expect(h).not.toContain("Threads");
  });
  it("points threads on v11", () => {
    const h = abortHint(11);
    expect(h).toContain("tm1_rest_read Threads");
    expect(h).toContain("Threads(id)/tm1.CancelOperation");
    expect(h).not.toContain("Jobs");
  });
});
