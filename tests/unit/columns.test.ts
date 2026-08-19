// columnsOf() replaced ~80 hand-written `{ header: "x", get: (r) => r.x }`
// literals across the tool files. Two of those shapes were collapsed into the
// bare field name, and this suite pins the claim that made that safe: the
// rendered cell is identical, including for the values where `??` and the
// escaper could plausibly disagree (null, undefined, 0, false, "").
import { describe, expect, it } from "vitest";
import { columnsOf, renderTable, type Column } from "../../src/tools/format.js";

interface Row {
  name: string;
  count: number;
  flag: boolean;
  note?: string | null | undefined;
  tags: string[];
}

const ROWS: Row[] = [
  { name: "a", count: 0, flag: false, note: undefined, tags: ["x", "y"] },
  { name: "b", count: 3, flag: true, note: null, tags: [] },
  { name: "c", count: -1, flag: false, note: "hi", tags: ["z"] },
];

describe("columnsOf", () => {
  it("renders a named field exactly like the explicit getter it replaced", () => {
    const explicit: Column<Row>[] = [
      { header: "name", get: (r) => r.name },
      { header: "count", get: (r) => r.count },
      { header: "flag", get: (r) => r.flag },
      { header: "note", get: (r) => r.note },
      { header: "tags", get: (r) => r.tags },
    ];
    const derived = columnsOf<Row>(["name", "count", "flag", "note", "tags"]);

    expect(renderTable(ROWS, derived)).toBe(renderTable(ROWS, explicit));
  });

  it('renders a named field exactly like the `?? ""` getter it replaced', () => {
    // The codemod collapsed this form too. `??` only fires on null/undefined,
    // which the escaper already prints as an empty cell — so 0 and false must
    // stay 0 and false on both paths.
    const withFallback: Column<Row>[] = [
      { header: "count", get: (r) => r.count ?? "" },
      { header: "flag", get: (r) => r.flag ?? "" },
      { header: "note", get: (r) => r.note ?? "" },
    ];
    const derived = columnsOf<Row>(["count", "flag", "note"]);

    expect(renderTable(ROWS, derived)).toBe(renderTable(ROWS, withFallback));
    expect(renderTable(ROWS, derived)).toContain("| 0 | false |  |");
  });

  it("keeps declaration order and passes explicit columns through untouched", () => {
    const computed: Column<Row> = {
      header: "tagCount",
      get: (r) => r.tags.length,
    };
    const columns = columnsOf<Row>(["name", computed, "count"]);

    expect(columns.map((c) => c.header)).toEqual(["name", "tagCount", "count"]);
    expect(columns[1]).toBe(computed);
    expect(renderTable(ROWS, columns)).toContain("| a | 2 | 0 |");
  });
});
