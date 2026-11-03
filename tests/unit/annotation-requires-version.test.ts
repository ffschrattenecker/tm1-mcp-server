import { describe, it, expect } from "vitest";
// Annotations live in the defineTool() specs; the barrel import runs them.
import "../../src/tools/index.js";
import { specFor } from "../../src/tools/define-tool.js";

describe("R2-21: requiresVersion annotation extension", () => {
  it("tags tm1_save_data as v11-only", () => {
    const annot = specFor("tm1_save_data")?.annotations;
    expect(annot, "tm1_save_data declares no annotation").toBeDefined();
    expect(annot?.requiresVersion).toBe("v11");
  });

  it("leaves version-agnostic tools untagged", () => {
    for (const tool of [
      "tm1_execute_mdx",
      "tm1_rest_read",
      "tm1_rest_write",
      "tm1_files_read",
    ]) {
      expect(specFor(tool)?.annotations.requiresVersion).toBeUndefined();
    }
  });
});
