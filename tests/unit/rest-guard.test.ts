import { describe, it, expect } from "vitest";
import {
  parsePath,
  planRead,
  planWrite,
  type WriteMethod,
} from "../../src/tools/rest/guard.js";
import { TM1Error } from "../../src/types.js";

// Run fn, expect a TM1Error, hand it back for assertions.
function errorOf(fn: () => unknown): TM1Error {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TM1Error);
    return e as TM1Error;
  }
  throw new Error("expected a TM1Error, got none");
}

describe("parsePath: malformed paths are rejected", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["https://evil/api/v1/Cubes", "absolute URL"],
    ["http:Cubes", "scheme"],
    ["//evil/Cubes", "protocol-relative"],
    ["/api/v1/Cubes", "leading /api/"],
    ["api/v1/Cubes", "leading api/"],
    ["%2Fapi%2Fv1%2FCubes", "encoded leading /api/"],
    ["Cubes/../Processes", ".."],
    ["Cubes/%2e%2e/Processes", "encoded .."],
    ["Cubes('..')", ".. inside a key"],
    ["Cubes/./Processes", "dot segment"],
    ["Cubes\\Processes", "backslash"],
    ["Cubes%5CProcesses", "encoded backslash"],
    ["Cubes\nProcesses", "newline"],
    ["Cubes%00", "NUL"],
    ["Cu​bes", "zero-width space"],
    ["Cubes#frag", "raw #"],
    ["Cubes//Views", "double slash"],
    ["Cubes('x", "unbalanced quote"],
    ["Cubes('x'", "unbalanced paren"],
    ["Cubes('x')junk", "junk after key"],
    ["Cubes?$filter=Name eq '50%'", "malformed escape"],
    ["Cubes%25252525252527", "too many encoding layers"],
    ["Processes%2528%2527P%2527%2529", "double-encoded"],
    ["Cubes/%252e%252e/Processes", "double-encoded .."],
  ])("%j (%s)", (path) => {
    expect(errorOf(() => parsePath(path)).code).toBe("VALIDATION_ERROR");
  });

  it("tokenizes quote-aware and decodes keys", () => {
    const p = parsePath(
      "/Dimensions('a/b')/Hierarchies('O''Brien')/Elements(%27x%3Fy%27)?$top=5",
    );
    expect(p.send).toBe(
      "Dimensions('a/b')/Hierarchies('O''Brien')/Elements(%27x%3Fy%27)?$top=5",
    );
    expect(p.segments).toEqual([
      { name: "dimensions", op: "dimensions", key: "a/b" },
      { name: "hierarchies", op: "hierarchies", key: "O'Brien" },
      { name: "elements", op: "elements", key: "x?y" },
    ]);
    expect(p.query).toBe("$top=5");
  });

  it("keeps a literal %25 in a filter value", () => {
    expect(parsePath("Cubes?$filter=contains(Name,'50%25')").query).toBe(
      "$filter=contains(Name,'50%')",
    );
  });

  it("drops one trailing slash and takes the op after the last dot", () => {
    expect(parsePath("Cubes('c')/ibm.tm1.api.v1.Unload/").segments[1]).toEqual({
      name: "ibm.tm1.api.v1.unload",
      op: "unload",
    });
  });
});

describe("planRead", () => {
  it.each([
    "Cubes?$select=Name&$filter=contains(tolower(Name),'x')",
    "Dimensions('D')/Hierarchies('H')?$expand=Elements($select=Name,Type;$top=50)",
    "Dimensions('D')/Hierarchies('H')/Elements/$count",
    "Processes('P')",
    "Chores?$expand=Tasks($expand=Process($select=Name))",
    "ErrorLogFiles('TM1ProcessError_x.log')/Content",
    "MessageLogEntries?$orderby=TimeStamp desc&$top=50",
    "Contents('Files')/Contents",
  ])("GET %s", (path) => {
    expect(planRead(path)).toMatchObject({ method: "GET", path });
  });

  it.each([
    "Processes('P')/tm1.Compile",
    "processes('P')/TM1.COMPILE",
    "Processes('P')/ibm.tm1.api.v1.Compile",
    "Processes(%27P%27)/tm1.Compile",
  ])("POST %s (the one read-only action)", (path) => {
    expect(planRead(path)).toEqual({ method: "POST", path });
  });

  it("refuses query options on compile", () => {
    expect(
      errorOf(() => planRead("Processes('P')/tm1.Compile?$top=1")).code,
    ).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["Cellsets('abc')", "tm1_execute_mdx"],
    ["Cellsets('abc')/Cells?$top=10", "tm1_execute_mdx"],
    ["CELLSETS('abc')", "tm1_execute_mdx"],
    ["Cubes('c')/Views('v')/tm1.Execute", "tm1_get_view"],
    ["ExecuteMDX", "tm1_execute_mdx"],
    ["ExecuteMDXSetExpression", "tm1_execute_mdx"],
    ["Processes('P')/tm1.ExecuteWithReturn", "tm1_execute_process"],
    ["$batch", "one at a time"],
    ["Cubes('c')/tm1.Unload", "tm1_rest_write"],
    ["Threads(5)/tm1.CancelOperation", "tm1_rest_write"],
    ["Contents('Files')/Contents('a.csv')/Content", "tm1_files_read"],
  ])("refuses %s → %s", (path, hint) => {
    const err = errorOf(() => planRead(path));
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
    expect(err.hint).toContain(hint);
  });
});

type Case = [WriteMethod, string, unknown, string];

describe("planWrite: blocklist", () => {
  const cases: Case[] = [
    // Process writes → tm1_upsert_process
    ["POST", "Processes", { Name: "P" }, "tm1_upsert_process"],
    ["PATCH", "Processes('P')", { PrologProcedure: "x" }, "tm1_upsert_process"],
    ["PUT", "Processes('P')", {}, "tm1_upsert_process"],
    ["PATCH", "processes('P')", {}, "tm1_upsert_process"],
    ["PATCH", "PROCESSES('P')", {}, "tm1_upsert_process"],
    ["PATCH", "%50rocesses('P')", {}, "tm1_upsert_process"],
    ["PATCH", "Processes%28%27P%27%29", {}, "tm1_upsert_process"],
    ["PATCH", " Processes('P')", {}, "tm1_upsert_process"],
    ["PATCH", "Processes ('P')", {}, "tm1_upsert_process"],
    ["POST", "Processes('P')/Parameters", {}, "tm1_upsert_process"],
    [
      "DELETE",
      "Processes('P')/Parameters('x')",
      undefined,
      "tm1_upsert_process",
    ],
    ["PATCH", "Chores('c')/Tasks(0)/Process", {}, "tm1_upsert_process"],
    [
      "POST",
      "ProcessDebugContexts('x')/tm1.Continue",
      undefined,
      "tm1_upsert_process",
    ],
    ["POST", "Processes('P')/tm1.Compile", undefined, "tm1_rest_read"],
    // Execution → execute tools
    [
      "POST",
      "ExecuteProcessWithReturn",
      { Process: {} },
      "tm1_execute_process",
    ],
    ["POST", "ExecuteProcess", { Process: {} }, "tm1_execute_process"],
    ["POST", "executeprocesswithreturn?$expand=*", {}, "tm1_execute_process"],
    ["POST", "Processes('P')/tm1.ExecuteWithReturn", {}, "tm1_execute_process"],
    ["POST", "Processes('P')/tm1.Execute", {}, "tm1_execute_process"],
    [
      "POST",
      "Processes('P')/ibm.tm1.api.v1.ExecuteWithReturn",
      {},
      "tm1_execute_process",
    ],
    ["POST", "Processes('P')/tm1.%45xecute", {}, "tm1_execute_process"],
    ["POST", "Chores('C')/tm1.Execute", undefined, "tm1_execute_chore"],
    ["POST", "Chores('C')/TM1.EXECUTECHORE", undefined, "tm1_execute_chore"],
    ["POST", "ExecuteMDX", { MDX: "SELECT" }, "tm1_execute_mdx"],
    ["POST", "ExecuteMDXSetExpression", { MDX: "{}" }, "tm1_execute_mdx"],
    ["POST", "Cubes('C')/Views('V')/tm1.Execute", {}, "tm1_get_view"],
    ["POST", "Cubes('C')/PrivateViews('V')/tm1.Execute", {}, "tm1_get_view"],
    // Rules → tm1_set_cube_rules
    ["PATCH", "Cubes('C')", { Rules: "SKIPCHECK;" }, "tm1_set_cube_rules"],
    ["PUT", "Cubes('C')", { rules: "SKIPCHECK;" }, "tm1_set_cube_rules"],
    ["POST", "Cubes", { Name: "C", RULES: "x" }, "tm1_set_cube_rules"],
    ["PATCH", "Cubes('C')", '{"Rules":"x"}', "tm1_set_cube_rules"],
    ["PATCH", "Cubes('C')", [{ Rules: "x" }], "tm1_set_cube_rules"],
    ["PATCH", "Cubes('C')", { "Rules@odata.type": "x" }, "tm1_set_cube_rules"],
    ["PATCH", "Cubes('C')/Rules", { value: "x" }, "tm1_set_cube_rules"],
    ["PUT", "Cubes('C')/Rules/$value", {}, "tm1_set_cube_rules"],
    ["DELETE", "Cubes('C')/Rules", undefined, "tm1_set_cube_rules"],
    // Cells → tm1_write_cells
    ["POST", "Cellsets('x')/Cells", {}, "tm1_write_cells"],
    ["PATCH", "Cellsets('x')/Cells", [], "tm1_write_cells"],
    ["DELETE", "Cellsets('x')", undefined, "tm1_write_cells"],
    ["POST", "Cubes('C')/tm1.Update", [], "tm1_write_cells"],
    ["POST", "Cellsets('x')/tm1.Update", [], "tm1_write_cells"],
    ["POST", "Cubes('C')/tm1.UpdateCells", [], "tm1_write_cells"],
    // $batch
    ["POST", "$batch", {}, "one at a time"],
    ["POST", "%24batch", {}, "one at a time"],
    ["POST", "$BATCH?x=1", {}, "one at a time"],
    ["POST", "Dimensions('D')/$batch", {}, "one at a time"],
    // SaveData / Clear
    ["POST", "tm1.SaveDataAll", undefined, "tm1_save_data"],
    ["POST", "Cubes('C')/tm1.SaveData", undefined, "tm1_save_data"],
    ["POST", "Cubes('C')/tm1.Clear", undefined, "tm1_clear_cube"],
    // Files
    ["POST", "Contents('Files')/Contents", { Name: "a" }, "tm1_files_write"],
    [
      "PUT",
      "Contents('Files')/Contents('a.csv')/Content",
      {},
      "tm1_files_write",
    ],
    [
      "DELETE",
      "Contents('Files')/Contents('a.csv')",
      undefined,
      "tm1_files_write",
    ],
    ["POST", "Files", {}, "tm1_files_write"],
    ["PUT", "Blobs('a')", {}, "tm1_files_write"],
    // Process definitions deep-inserted outside Processes → tm1_upsert_process
    [
      "POST",
      "Chores",
      { Name: "c", Tasks: [{ Step: 0, Process: { Name: "New" } }] },
      "tm1_upsert_process",
    ],
    [
      "POST",
      "Chores",
      {
        Name: "c",
        Tasks: [{ Step: 0, Process: { Name: "New", PrologProcedure: "x" } }],
      },
      "tm1_upsert_process",
    ],
    [
      "PATCH",
      "Chores('c')/Tasks(0)",
      { Process: { Name: "New" } },
      "tm1_upsert_process",
    ],
    ["POST", "Chores", { Processes: [{ Name: "P" }] }, "tm1_upsert_process"],
    ["PATCH", "Chores('c')", { epilogprocedure: "x" }, "tm1_upsert_process"],
  ];

  it.each(cases)("%s %s → %s", (method, path, body, hint) => {
    const err = errorOf(() => planWrite(method, path, body));
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
    expect(err.message).toContain("Nothing was sent");
    expect(err.hint).toContain(hint);
  });
});

describe("planWrite: allowed", () => {
  it.each([
    ["POST", "Dimensions", { Name: "D" }],
    ["PATCH", "Chores('X')", { Active: true }],
    ["POST", "Cubes('C')/tm1.Unload", undefined],
    [
      "POST",
      "Cubes",
      { Name: "C", "Dimensions@odata.bind": ["Dimensions('D')"] },
    ],
    ["POST", "Chores", { Tasks: [{ "Process@odata.bind": "Processes('P')" }] }],
    ["POST", "Cubes('C')/Views", { Name: "V", MDX: "SELECT" }],
    ["PATCH", "Users('u')", { "Groups@odata.bind": ["Groups('g')"] }],
    [
      "PATCH",
      "Chores('c')/Tasks(0)",
      { "Process@odata.bind": "Processes('P')" },
    ],
    ["PATCH", "Chores('c')/Tasks(0)", { Process: null }],
  ] as const)("%s %s", (method, path, body) => {
    const plan = planWrite(method, path, body);
    expect(plan).toMatchObject({ method, path });
    expect(plan.confirmTarget).toBeUndefined();
  });

  it("parses a JSON string body, refuses an unparsable one", () => {
    expect(planWrite("PATCH", "Chores('X')", '{"Active":false}').body).toEqual({
      Active: false,
    });
    expect(errorOf(() => planWrite("PATCH", "Chores('X')", "{nope")).code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses a DELETE body", () => {
    expect(
      errorOf(() => planWrite("DELETE", "Chores('X')", { a: 1 })).code,
    ).toBe("VALIDATION_ERROR");
  });
});

describe("planWrite: confirm target", () => {
  it.each([
    ["DELETE", "Processes('P')", "P"],
    ["DELETE", "Cubes('Sales')", "Sales"],
    [
      "DELETE",
      "Dimensions('D')/Hierarchies('H')/Elements('O''Brien')",
      "O'Brien",
    ],
    ["DELETE", "Dimensions('D')/Hierarchies('H')/Elements(%27a%2Fb%27)", "a/b"],
    ["DELETE", "Cubes('C')/Views('V')", "V"],
    ["DELETE", "Users('u')/Groups?$id=Groups('g')", "g"],
    ["DELETE", "Users('u')/Groups('g')/$ref", "g"],
    ["POST", "Threads(123)/tm1.CancelOperation", "123"],
    ["POST", "Jobs('j1')/tm1.Cancel", "j1"],
    ["POST", "Sessions(7)/tm1.Close", "7"],
  ] as const)("%s %s → %s", (method, path, target) => {
    expect(planWrite(method, path).confirmTarget).toBe(target);
  });

  // On an entity DELETE, TM1 deletes the path's object; a stray $id must not
  // become the confirm target.
  it.each([
    "Cubes('Sales')?$id=Views('x')",
    "Cubes('Sales')/Views('V')?$id=Views('x')",
    "Dimensions('D')?%24id=Dimensions('other')",
  ])("refuses $id on an entity DELETE: %s", (path) => {
    const err = errorOf(() => planWrite("DELETE", path));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("$id");
  });

  it("honours $id on a $ref delete", () => {
    expect(
      planWrite("DELETE", "Users('u')/Groups/$ref?$id=Groups('g')")
        .confirmTarget,
    ).toBe("g");
  });

  it.each([
    ["DELETE", "Cubes"],
    ["POST", "ActiveSession/tm1.Close"],
  ] as const)("refuses %s %s (no keyed target)", (method, path) => {
    expect(errorOf(() => planWrite(method, path)).code).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("parsePath: segment-name alphabet", () => {
  it.each([
    "Cellsets;x('a')",
    "Сellsets('a')", // Cyrillic С
    "Cubes x",
    "$ba-tch",
    "('x')",
  ])("rejects %j", (path) => {
    expect(errorOf(() => parsePath(path)).code).toBe("VALIDATION_ERROR");
  });

  it.each(["_async('id')", "Cubes/$count", "Users('u')/Groups('g')/$ref"])(
    "accepts %j",
    (path) => {
      expect(() => parsePath(path)).not.toThrow();
    },
  );
});

describe("planRead: maskCode flag", () => {
  it.each([
    "Processes('P')/PrologProcedure",
    "Processes('P')/PrologProcedure/$value",
    "processes('P')?$select=EpilogProcedure",
    "Chores('c')/Tasks(0)/Process/DataProcedure/$value",
  ])("flags %s", (path) => {
    expect(planRead(path)).toMatchObject({ method: "GET", maskCode: true });
  });

  it("leaves non-process paths unflagged", () => {
    expect(planRead("Cubes?$select=Name").maskCode).toBeUndefined();
  });
});

// A path that names the secret property gets the bare secret back, with no
// secret-named key for maskSecretsDeep to find.
describe("planRead: maskSecret flag", () => {
  it.each([
    "Processes('P')/DataSource/password",
    "Processes('P')/DataSource/password/$value",
    "ActiveConfiguration/Access/LDAP/Password/$value",
    "Configuration/Access/LDAP/Password",
  ])("flags %s", (path) => {
    expect(planRead(path)).toMatchObject({ method: "GET", maskSecret: true });
  });

  it("leaves paths without a secret segment unflagged", () => {
    expect(planRead("Processes('P')/DataSource").maskSecret).toBeUndefined();
    expect(planRead("Cubes?$select=Name").maskSecret).toBeUndefined();
  });

  it("flags a write whose echo could be the secret", () => {
    expect(
      planWrite("PATCH", "StaticConfiguration/Access/LDAP/Password", {
        value: "x",
      }),
    ).toMatchObject({ method: "PATCH", maskSecret: true });
  });
});

describe("$entity is refused", () => {
  it.each([
    "$entity?$id=Processes('P')/DataSource/password",
    "$entity?$id=Cellsets('x')",
    "%24entity?%24id=Processes('P')",
  ])("planRead refuses %s", (path) => {
    const err = errorOf(() => planRead(path));
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
    expect(err.message).toContain("$entity");
  });

  it("planWrite refuses it too", () => {
    const err = errorOf(() =>
      planWrite("PATCH", "$entity?$id=Dimensions('D')", { Name: "D" }),
    );
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
  });
});

describe("the path is classified as TM1 decodes it: once", () => {
  // Decoded twice, %2527 is a quote and the whole middle reads as one key of
  // Cubes; TM1 sees Cubes('a%27') / Rules / x('%27b'), a write to Rules.
  it.each([
    ["POST", "Cubes('a%2527')/Rules/x('%2527b')"],
    ["PATCH", "Cubes('a%2527')/Processes/x('%2527b')"],
  ] as const)("refuses %s %s instead of mis-parsing it", (method, path) => {
    const err = errorOf(() => planWrite(method, path, {}));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("encoded more than once");
  });

  it("still decodes a once-encoded quote in a key", () => {
    expect(parsePath("Cubes(%27O%27%27Brien%27)").segments).toEqual([
      { name: "cubes", op: "cubes", key: "O'Brien" },
    ]);
  });

  it("classifies the query once-decoded, as TM1 sees it", () => {
    expect(parsePath("Cubes?$filter=Name eq '%2541'").query).toBe(
      "$filter=Name eq '%41'",
    );
  });
});

describe("secrets and TI code are refused inside query expressions", () => {
  it.each([
    "Processes?$select=Name&$filter=startswith(DataSource/password,'a')",
    "Processes?$filter=contains(PrologProcedure,'ODBCOpen')",
    "Processes?$orderby=DataSource/password",
    "Processes?$expand=DataSource($filter=startswith(password,'a'))",
    "Processes?$filter=startswith(@p,'a')&@p=DataSource/password",
    "Processes?%24filter=startswith(DataSource%2Fpassword,'a')",
    "Processes?$search=password",
    "Processes/$filter(contains(EpilogProcedure,'x'))",
  ])("planRead refuses %s", (path) => {
    const err = errorOf(() => planRead(path));
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
    expect(err.hint).toContain("tm1_search_code");
  });

  it("planWrite refuses it too", () => {
    const err = errorOf(() =>
      planWrite("DELETE", "Users('u')/Groups/$ref?$filter=password eq 'x'"),
    );
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
  });

  it.each([
    "Processes?$select=Name,DataSource&$filter=startswith(Name,'password')",
    "Processes?$select=DataSource/password",
    "Processes?$expand=DataSource($select=password)",
    "Users?$filter=Name eq 'auth''token'&$orderby=Name desc",
  ])("allows a secret name that is only selected or quoted: %s", (path) => {
    expect(planRead(path).method).toBe("GET");
  });
});
