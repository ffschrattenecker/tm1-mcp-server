// The contract checker is load-bearing for ~40 other test files: if it says
// "conforms" too easily, every fake it guards goes unchecked. These cases pin
// the parts that decide that — array merging, optionality, union types, and
// the subset/exact split.
import { describe, it, expect } from "vitest";
import {
  shapeOf,
  mergeShapes,
  endpointKey,
  diffAgainstShape,
  type CheckOptions,
  type Shape,
} from "../helpers/wire-contract.js";

describe("shapeOf", () => {
  it.each([
    [
      "records primitive types, not values",
      { Name: "Sales", Cells: 42, Ok: true },
      { Cells: "number", Name: "string", Ok: "boolean" },
    ],
    [
      "marks an array key with [] and merges its elements",
      { value: [{ Name: "a" }, { Name: "b" }] },
      { "value[]": { Name: "string" } },
    ],
    // This is the whole reason arrays are merged rather than sampled: TM1
    // omits keys per row (Attributes present on one element, absent on the
    // next), and a contract built from element 0 alone would call the second
    // element a violation.
    [
      "makes a key optional when some element lacks it",
      { value: [{ Name: "a" }, { Name: "b", Alias: "x" }] },
      { "value[]": { "Alias?": "string", Name: "string" } },
    ],
    [
      "unions differing primitive types",
      [{ V: 1 }, { V: null }],
      { "[]": { V: "null|number" } },
    ],
    // Inside an object the `[]` rides on the key; at the root there is no key,
    // so a service returning `CubeRules[]` would otherwise be indistinguishable
    // from one returning a single CubeRules.
    [
      "keeps a root-level array recognisable as an array",
      [{ Name: "a" }],
      { "[]": { Name: "string" } },
    ],
    [
      "omits keys whose value is undefined",
      { a: 1, b: undefined },
      { a: "number" },
    ],
    [
      "represents an empty array as unknown rather than guessing",
      { items: [] },
      { "items[]": "unknown" },
    ],
  ])("%s", (_name, input, expected) => {
    expect(shapeOf(input)).toEqual(expected);
  });

  it("sorts keys so re-recording produces a readable diff", () => {
    expect(Object.keys(shapeOf({ b: 1, a: 2, c: 3 }))).toEqual(["a", "b", "c"]);
  });
});

describe("mergeShapes", () => {
  // An empty `Parents: []` on one element and a populated one on the next is
  // the norm in TM1. Merging these into the union "object" would erase the
  // element shape and make every later check pass vacuously.
  it.each<[string, Shape | string, Shape | string, Shape | string]>([
    [
      "drops `unknown` once a real observation exists",
      "unknown",
      "string",
      "string",
    ],
    [
      "lets a real element shape supersede the empty-array marker",
      "unknown",
      { Name: "string" },
      { Name: "string" },
    ],
    [
      "lets a real element shape supersede the marker on either side",
      { Name: "string" },
      "unknown",
      { Name: "string" },
    ],
    [
      "keeps a key optional once either side saw it optional",
      { "X?": "string", Y: "number" },
      { X: "string", Y: "number" },
      { "X?": "string", Y: "number" },
    ],
    [
      "surfaces a primitive/object clash as a union instead of picking one",
      "string",
      { a: "number" },
      "object|string",
    ],
  ])("%s", (_name, a, b, expected) => {
    expect(mergeShapes(a, b)).toEqual(expected);
  });
});

describe("endpointKey", () => {
  it.each([
    [
      "strips object names — normalization and name-scrubbing in one",
      "get",
      "/api/v1/Cubes('Sales_2026')/Views?$top=5",
      "GET /api/v1/Cubes('*')/Views",
    ],
    // `/acme_prod/api/v1/...` would otherwise commit a customer's instance
    // name into an endpoint key.
    [
      "strips the v12 instance segment, which is deployment-specific",
      "GET",
      "/acme_prod/api/v1/Databases('Sales')/Cubes",
      "GET /*/api/v1/Databases('*')/Cubes",
    ],
    // v11 has no such prefix and must stay untouched.
    [
      "leaves a v11 path without an instance segment untouched",
      "GET",
      "/api/v1/Cubes",
      "GET /api/v1/Cubes",
    ],
    [
      "strips numeric keys",
      "PATCH",
      "/api/v1/Cellsets('abc')/Cells(0)",
      "PATCH /api/v1/Cellsets('*')/Cells(*)",
    ],
  ])("%s", (_name, method, path, expected) => {
    expect(endpointKey(method, path)).toBe(expected);
  });
});

describe("diffAgainstShape", () => {
  const CONTRACT: Shape = {
    "@odata.count?": "number",
    "value[]": { Name: "string", "Dimensions[]": { Name: "string" } },
  };
  // What a merge of two versions produces when one sends null, the other [].
  const MERGED: Shape = { "Names?": "null", "Names[]?": "string" };
  const EXACT: CheckOptions = { mode: "exact" };

  it.each<[string, unknown, Shape, CheckOptions | undefined]>([
    // $select drops keys, so a payload that omits them conforms.
    [
      "accepts a payload that omits keys (that is what $select does)",
      { value: [{ Name: "a" }] },
      CONTRACT,
      undefined,
    ],
    // `@odata.count` appears only when the request asked for $count, and
    // contracts are filed with the query stripped — so its absence from a
    // recording says nothing about the payload being wrong.
    [
      "allows OData control annotations the contract never recorded",
      { value: [{ Name: "a" }], "Elements@odata.count": 3 },
      CONTRACT,
      undefined,
    ],
    // JSON cannot express `undefined`; a fake that spreads optional fields
    // produces it routinely and is making no claim by doing so.
    [
      "treats an explicit undefined as an absent key",
      { value: [{ Name: "a", Nope: undefined }] },
      CONTRACT,
      undefined,
    ],
    [
      "treats `unknown` as satisfied by anything",
      { items: [1, 2] },
      { "items[]": "unknown" },
      undefined,
    ],
    // `Statements[]: "string"` means "array whose elements are strings", not
    // "a string". Comparing the array itself against the primitive would call
    // every string array a type error.
    [
      "checks an array of primitives element-wise",
      { Statements: ["a", "b"] },
      { "Statements[]": "string" },
      undefined,
    ],
    [
      "accepts null where the contract recorded a nullable",
      { V: null },
      { V: "null|number" },
      undefined,
    ],
    [
      "accepts a scalar null for a key recorded as both scalar and array",
      { Names: null },
      MERGED,
      EXACT,
    ],
    [
      "accepts an array for a key recorded as both scalar and array",
      { Names: ["a"] },
      MERGED,
      EXACT,
    ],
  ])("%s", (_name, payload, contract, opts) => {
    expect(diffAgainstShape(payload, contract, opts)).toEqual([]);
  });

  it.each<[string, unknown, Shape, CheckOptions | undefined, number]>([
    [
      "rejects an array of the wrong primitive element type",
      { Statements: [1] },
      { "Statements[]": "string" },
      undefined,
      1,
    ],
    [
      "rejects null where the contract recorded only a number",
      { V: null },
      { V: "number" },
      undefined,
      1,
    ],
    [
      "rejects an array where the merged shape records only a scalar in exact mode",
      { Names: [1] },
      MERGED,
      EXACT,
      1,
    ],
    [
      "lists every divergence at once",
      { value: [{ Name: 1, Bogus: 2 }] },
      CONTRACT,
      undefined,
      2,
    ],
  ])("%s", (_name, payload, contract, opts, count) => {
    expect(diffAgainstShape(payload, contract, opts)).toHaveLength(count);
  });

  it("rejects a key the server never sends", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: "a", Invented: true }] },
      CONTRACT,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Invented");
    expect(problems[0]).toContain("does not send this key");
  });

  it("rejects a wrong primitive type", () => {
    const problems = diffAgainstShape({ value: [{ Name: 7 }] }, CONTRACT);
    expect(problems[0]).toContain("contract says string, payload has number");
  });

  it("rejects a scalar where the contract has an array", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: "a", Dimensions: "Time" }] },
      CONTRACT,
    );
    expect(problems[0]).toContain("contract says array");
  });

  it("reports the path of a nested divergence", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: "a", Dimensions: [{ Name: 1 }] }] },
      CONTRACT,
    );
    expect(problems[0]).toContain("$.value[0].Dimensions[0].Name");
  });

  it("exact mode additionally demands the required keys", () => {
    expect(diffAgainstShape({}, CONTRACT, EXACT)).toEqual([
      "$.value: required by the contract, missing from the payload",
    ]);
    // The optional one is not demanded.
    expect(diffAgainstShape({ value: [] }, CONTRACT, EXACT)).toEqual([]);
  });
});
