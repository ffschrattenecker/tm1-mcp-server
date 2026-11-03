import { describe, it, expect } from "vitest";
import {
  CUBE_ARG_IDX,
  DIM_ARG_IDX,
  PROCESS_ARG_IDX,
  ELEM_ARG_IDX,
  SUBSET_ARG_IDX,
  FUNC_RE,
} from "../../src/lib/callgraph/referenceIndex.js";

// The full tables are exercised behaviourally by the callgraph, data-flow and
// process-refs tests. These pins cover only the entries that were corrected by
// hand or are easy to get wrong.

const TABLES = {
  cube: CUBE_ARG_IDX,
  dimension: DIM_ARG_IDX,
  process: PROCESS_ARG_IDX,
  element: ELEM_ARG_IDX,
  subset: SUBSET_ARG_IDX,
} as const;

const PINNED: Array<[keyof typeof TABLES, string, number]> = [
  ["cube", "cellputn", 1],
  ["cube", "viewsubsetassign", 0],
  ["dimension", "viewsubsetassign", 2],
  ["subset", "viewsubsetassign", 3],
  ["dimension", "subsetelementadd", 0],
  ["subset", "subsetelementadd", 1],
  ["dimension", "subsetcreate", 0],
  ["subset", "subsetcreate", 1],
  ["subset", "subsetcreatebymdx", 0],
  ["element", "elementattrputs", 3],
  ["cube", "dbr", 0],
  ["cube", "dbs", 1],
  ["cube", "dbss", 1],
];

const matchesFunc = (name: string): boolean =>
  new RegExp(FUNC_RE.source, "i").test(`${name}(`);

describe("callgraph TI arg-index tables", () => {
  it.each(PINNED)("%s table maps %s to argument %i", (table, fn, index) => {
    expect(TABLES[table].get(fn)).toBe(index);
  });

  it.each(["executeprocess", "runprocess"])(
    "%s is matched by FUNC_RE",
    (fn) => {
      expect(matchesFunc(fn)).toBe(true);
    },
  );

  it("every cube, dimension and process key is matched by FUNC_RE, and nothing else is", () => {
    const tracked = [
      ...CUBE_ARG_IDX.keys(),
      ...DIM_ARG_IDX.keys(),
      ...PROCESS_ARG_IDX.keys(),
    ];
    const alternation = FUNC_RE.source
      .slice("\\b(".length, FUNC_RE.source.indexOf(")\\s*\\("))
      .split("|");
    expect(new Set(alternation)).toEqual(new Set(tracked));
    for (const fn of tracked) expect(matchesFunc(fn)).toBe(true);
  });
});
