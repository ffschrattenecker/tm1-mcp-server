import { describe, expect, it } from "vitest";
import {
  HierarchyService,
  STRUCTURE_PAGE_SIZE,
} from "../../src/tm1-client/services/hierarchy-service.js";

describe("HierarchyService.getStructure", () => {
  it("pages by name and keeps edges that cross page boundaries", async () => {
    // One full page plus one row: the parent sits on page 2, its children on page 1.
    const total = STRUCTURE_PAGE_SIZE + 1;
    const rows = Array.from({ length: total }, (_, i) => ({
      Name: i === total - 1 ? "ZZ Total" : `E${String(i).padStart(6, "0")}`,
      Type: i === total - 1 ? "Consolidated" : "Numeric",
      Edges:
        i === total - 1
          ? [
              { ComponentName: "E000000", Weight: 1 },
              { ComponentName: "E000001", Weight: -1 },
            ]
          : [],
    }));
    const paths: string[] = [];
    const service = new HierarchyService({
      request: async (_method: string, path: string) => {
        paths.push(path);
        const skip = Number(/\$skip=(\d+)/.exec(path)![1]);
        const top = Number(/\$top=(\d+)/.exec(path)![1]);
        return { value: rows.slice(skip, skip + top) };
      },
    } as unknown as ConstructorParameters<typeof HierarchyService>[0]);

    const s = await service.getStructure("Region", "Region");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("$orderby=Name");
    expect(paths[0]).toContain("$expand=Edges($select=ComponentName,Weight)");
    expect(s.elements).toHaveLength(total);
    expect(s.edges).toEqual([
      { parent: "ZZ Total", child: "E000000", weight: 1 },
      { parent: "ZZ Total", child: "E000001", weight: -1 },
    ]);
  });
});
