import { describe, it, expect } from "vitest";
import {
  READ_ONLY,
  IDEMPOTENT_WRITE,
  withVersion,
  type Tm1ToolAnnotations,
} from "../../src/tools/annotations.js";
// Annotations live in the defineTool() specs; the barrel import runs them.
import "../../src/tools/index.js";
import { specFor } from "../../src/tools/define-tool.js";

describe("R2-21: requiresVersion annotation extension", () => {
  describe("withVersion()", () => {
    it("returns a new annotation with requiresVersion attached", () => {
      const tagged = withVersion(READ_ONLY, "v11");
      expect(tagged.requiresVersion).toBe("v11");
      expect(tagged.readOnlyHint).toBe(true);
    });

    it("does not mutate the base annotation", () => {
      withVersion(READ_ONLY, "v12");
      expect((READ_ONLY as Tm1ToolAnnotations).requiresVersion).toBeUndefined();
    });

    it("preserves all base hints", () => {
      const tagged = withVersion(IDEMPOTENT_WRITE, "v11");
      expect(tagged.readOnlyHint).toBe(false);
      expect(tagged.idempotentHint).toBe(true);
      expect(tagged.destructiveHint).toBe(false);
      expect(tagged.openWorldHint).toBe(true);
    });
  });

  describe("requiresVersion tags", () => {
    // Only tools the server actually withholds on v12 carry the tag. The
    // .pro tools and the cell diagnostics used to be tagged too and were
    // measured working on 12.5.9 — see the "not tagged" case below.
    const v11OnlyTools = [
      "tm1_save_data",
      "tm1_get_audit_log",
      "tm1_get_message_log",
      "tm1_get_transaction_log",
    ];

    it.each(v11OnlyTools)("%s is tagged requiresVersion='v11'", (tool) => {
      const annot = specFor(tool)?.annotations;
      expect(annot, `${tool} declares no annotation`).toBeDefined();
      expect(annot?.requiresVersion).toBe("v11");
    });

    it("untagged tools have no requiresVersion field (version-agnostic)", () => {
      const sample = [
        "tm1_list_cubes",
        "tm1_execute_mdx",
        "tm1_create_dimension",
        "tm1_get_cell_value",
      ];
      for (const tool of sample) {
        expect(specFor(tool)?.annotations.requiresVersion).toBeUndefined();
      }
    });

    // These carried requiresVersion:"v11" and three of them said "v11 only."
    // in their description. Measured against 12.5.9: the .pro round-trip and
    // all three cell-bound trace actions answer normally, so the tag claimed a
    // limit the server does not have and steered callers off a working tool.
    it("tools that were wrongly tagged v11 carry no version claim", () => {
      const measuredOnV12 = [
        "tm1_check_feeders",
        "tm1_trace_feeders",
        "tm1_trace_cell_calculation",
        "tm1_export_process_to_pro",
        "tm1_import_pro_file",
        "tm1_install_pro_bundle",
        "tm1_diff_process_with_file",
        "tm1_check_v12_readiness",
      ];
      for (const tool of measuredOnV12) {
        expect(specFor(tool), `${tool} declares no spec`).toBeDefined();
        expect(specFor(tool)?.annotations.requiresVersion).toBeUndefined();
      }
    });

    it("requiresVersion field is JSON-serializable (survives wire transport)", () => {
      const annot = specFor("tm1_save_data")?.annotations;
      const roundTrip = JSON.parse(JSON.stringify(annot));
      expect(roundTrip.requiresVersion).toBe("v11");
      expect(roundTrip.idempotentHint).toBe(true);
    });
  });
});
