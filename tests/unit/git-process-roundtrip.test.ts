import { describe, it, expect } from "vitest";
import {
  EMPTY_CODE_BLOB,
  serializeProcessToGit,
  toCodeBlob,
  parseProcessFromGit,
  type NativeProcessHeader,
} from "../../src/lib/git-process.js";

/** A process as TM1 REST returns it for the git field list. */
function fixture(over: Partial<NativeProcessHeader> = {}): NativeProcessHeader {
  return {
    Name: "MyProc",
    HasSecurityAccess: false,
    UIData: "CubeAction=1511\fDataAction=1503\fCubeLogChanges=0\f",
    VariablesUIData: [],
    DataSource: { Type: "None" },
    Parameters: [
      { Name: "pNum", Prompt: "a number", Value: 42, Type: "Numeric" },
      { Name: "pStr", Prompt: "a string", Value: "default", Type: "String" },
    ],
    Variables: [
      {
        Name: "vCol1",
        Type: "String",
        Position: 1,
        StartByte: 0,
        EndByte: 0,
      },
      {
        Name: "vCol2",
        Type: "Numeric",
        Position: 2,
        StartByte: 0,
        EndByte: 0,
      },
    ],
    ...over,
  };
}

/** Build a native #region blob the way the TM1 server emits it (CRLF,
 *  empty tabs omitted). Tab keys are Capitalized. */
function makeTi(
  tabs: Partial<Record<"Prolog" | "Metadata" | "Data" | "Epilog", string>>,
): string {
  return (["Prolog", "Metadata", "Data", "Epilog"] as const)
    .filter((k) => tabs[k] && tabs[k].length > 0)
    .map((k) => `#region ${k}\r\n${tabs[k]}\r\n#endregion`)
    .join("\r\n");
}

describe("git-process #region round-trip", () => {
  it("writes the REST payload as it came: server key order, no renamed fields", () => {
    const { json } = serializeProcessToGit(
      fixture({
        Parameters: [{ Name: "pA", Prompt: "", Value: 1, Type: "Numeric" }],
        Variables: [],
      }),
    );
    expect(json).toBe(
      `{
  "Name": "MyProc",
  "HasSecurityAccess": false,
  "UIData": "CubeAction=1511\\fDataAction=1503\\fCubeLogChanges=0\\f",
  "VariablesUIData": [],
  "DataSource": {
    "Type": "None"
  },
  "Parameters": [
    {
      "Name": "pA",
      "Prompt": "",
      "Value": 1,
      "Type": "Numeric"
    }
  ],
  "Variables": []
}
`,
    );
  });

  it("reads the export of a process without code back as four empty tabs", () => {
    const json = serializeProcessToGit(fixture()).json;
    const parsed = parseProcessFromGit(json, EMPTY_CODE_BLOB);
    expect([
      parsed.prolog,
      parsed.metadata,
      parsed.data,
      parsed.epilog,
    ]).toEqual(["", "", "", ""]);
  });

  it("keeps TM1 12's layout: lists last in the .json, trailing newline before #endregion", () => {
    // 12.5.9 sends UIData/VariablesUIData after Variables and always puts a
    // line break before #endregion, so a tab ending in one shows a blank line.
    const { UIData, VariablesUIData, ...rest } = fixture();
    const { json } = serializeProcessToGit({
      ...rest,
      UIData: UIData!,
      VariablesUIData: VariablesUIData!,
    });
    expect(Object.keys(JSON.parse(json)).slice(-2)).toEqual([
      "UIData",
      "VariablesUIData",
    ]);
    const parsed = parseProcessFromGit(
      json,
      "#region Prolog\r\np;\r\n\r\n#endregion",
    );
    expect(parsed.prolog).toBe("p;\r\n");
  });

  it("puts UIData before VariablesUIData when TM1 12 sends them swapped", () => {
    // 1 of 103 processes on 12.5.9; the VS Code extension writes UIData first.
    const { UIData, VariablesUIData, ...rest } = fixture();
    const { json } = serializeProcessToGit({
      ...rest,
      VariablesUIData: VariablesUIData!,
      UIData: UIData!,
    });
    expect(Object.keys(JSON.parse(json))).toEqual([
      "Name",
      "HasSecurityAccess",
      "DataSource",
      "Parameters",
      "Variables",
      "UIData",
      "VariablesUIData",
    ]);
  });

  it("parses #region tabs into prolog/metadata/data/epilog; omitted tab is empty", () => {
    const ti = makeTi({
      Prolog: "sP='p';",
      Data: "sD='d';",
      Epilog: "sE='e';",
    });
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe("sP='p';");
    expect(parsed.metadata).toBe("");
    expect(parsed.data).toBe("sD='d';");
    expect(parsed.epilog).toBe("sE='e';");
  });

  it("parses #region case-insensitively (lowercase tab name)", () => {
    const ti = "#region prolog\r\nsP='p';\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti).prolog).toBe("sP='p';");
  });

  it("rejects a .ti with no #region markers (hard-cut)", () => {
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() =>
      parseProcessFromGit(json, "just some text\nno markers"),
    ).toThrow(/#region/);
  });

  it("rejects the pre-1.x ### TM1-TI-TAB: layout (hard-cut)", () => {
    const legacy = "### TM1-TI-TAB: prolog ###\n### TM1-TI-TAB: metadata ###\n";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() => parseProcessFromGit(json, legacy)).toThrow(/#region/);
  });

  it("rejects a blob with a missing #endregion (next tab's #region follows directly) instead of silently swallowing the following tab", () => {
    // Prolog's #endregion is missing/typo'd; Metadata's #region follows directly.
    // A later tab opening inside a tab is rejected rather than silently
    // absorbing Metadata into Prolog.
    const ti =
      "#region Prolog\r\nsP='p';\r\n#region Metadata\r\nsM='m';\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/#region/);
  });

  it("parses a nested #region/#endregion inside a tab's code (e.g. an editor folding comment) — preserved verbatim, not rejected", () => {
    // A #region/#endregion pair nested inside Prolog's code (e.g. a PAW/Arc
    // folding comment). This is legitimate user content, not a structural
    // marker: depth-aware parsing must keep it as part of Prolog's code rather
    // than closing on the first #endregion it finds.
    const ti =
      "#region Prolog\r\ncode before;\r\n#region MyFold\r\nfolded stuff;\r\n#endregion\r\ncode after;\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe(
      "code before;\r\n#region MyFold\r\nfolded stuff;\r\n#endregion\r\ncode after;",
    );
  });

  it("parses the live-confirmed export: a WHILE loop wrapped in a nested #region fold inside Prolog", () => {
    // Live-confirmed export of a process where the TM1 user wrapped a WHILE
    // loop in their own #region schleife1 / #endregion folding comment inside
    // the Prolog tab. #region Prolog is the tab; #region schleife1 … #endregion
    // is the nested user fold; the final #endregion closes the Prolog tab.
    const ti =
      "#region Prolog\r\nLogOutput('INFO','start');\r\n#region schleife1\r\nnI = 1;\r\n" +
      "WHILE(nI <= 3);\r\nLogOutput('INFO', NumberToString(nI));\r\nnI = nI + 1;\r\nEND;\r\n" +
      "#endregion\r\nLogOutput('INFO','end');\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const parsed = parseProcessFromGit(json, ti);
    const expectedProlog =
      "LogOutput('INFO','start');\r\n#region schleife1\r\nnI = 1;\r\n" +
      "WHILE(nI <= 3);\r\nLogOutput('INFO', NumberToString(nI));\r\nnI = nI + 1;\r\nEND;\r\n" +
      "#endregion\r\nLogOutput('INFO','end');";
    expect(parsed.prolog).toBe(expectedProlog);
    expect(parsed.prolog).toContain("#region schleife1");
    expect(parsed.prolog).toContain("#endregion");

    // Round-trips: re-serializing the same blob shape reproduces the tab.
    const roundTrip = `#region Prolog\r\n${parsed.prolog}\r\n#endregion`;
    expect(roundTrip).toBe(ti);
  });

  it("parses a deeply nested fold (2 levels of user #region inside a tab)", () => {
    const ti =
      "#region Prolog\r\nouter start;\r\n#region Outer\r\nouter code;\r\n#region Inner\r\n" +
      "inner code;\r\n#endregion\r\nmore outer;\r\n#endregion\r\nouter end;\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe(
      "outer start;\r\n#region Outer\r\nouter code;\r\n#region Inner\r\n" +
        "inner code;\r\n#endregion\r\nmore outer;\r\n#endregion\r\nouter end;",
    );
  });

  it("keeps a trailing #endregion inside the tab: the server writes this blob for a tab whose code ends with one", () => {
    const ti = "#region Prolog\r\nsP='p';\r\n#endregion\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti).prolog).toBe("sP='p';\r\n#endregion");
  });

  it("ignores broken user folds: a fold never closed, a stray #EndRegion, a fold named like a tab", () => {
    // 2 of 366 processes on an 11.8 server leave a fold open; depth counting
    // rejected their export. Only the four tab markers are structure.
    const ti = makeTi({
      Prolog: "#Region never closed\r\nx = 1;\r\n#Region Data",
      Metadata: "#EndRegion\r\ny = 2;",
      Data: "z = 3;",
      Epilog: "#region Prolog\r\nw = 4;\r\n#EndRegion wrong",
    });
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti)).toMatchObject({
      prolog: "#Region never closed\r\nx = 1;\r\n#Region Data",
      metadata: "#EndRegion\r\ny = 2;",
      data: "z = 3;",
      epilog: "#region Prolog\r\nw = 4;\r\n#EndRegion wrong",
    });
  });

  it("reads the VS Code extension's former layout: lowercase tabs closed by `#endregion <tab>`", () => {
    // Written by the extension before 2026-10-10 (LF, one break before each close).
    const ti =
      "#region prolog\nx = 1;\n#endregion prolog\n#region metadata\n\n#endregion metadata\n" +
      "#region data\n#EndRegion\ny = 2;\n#endregion data\n#region epilog\n\n#endregion epilog";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti)).toMatchObject({
      prolog: "x = 1;",
      metadata: "",
      data: "#EndRegion\ny = 2;",
      epilog: "",
    });
  });

  it("sends a native .ti as it is and rebuilds the former layout into TM1's blob", () => {
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const native = "#region Prolog\r\nx = 1;\r\n\r\n#endregion";
    expect(toCodeBlob(native, parseProcessFromGit(json, native))).toBe(native);
    const former =
      "#region prolog\nx = 1;\n#endregion prolog\n#region metadata\n\n#endregion metadata\n" +
      "#region data\n#EndRegion\n#endregion data\n#region epilog\n\n#endregion epilog";
    expect(toCodeBlob(former, parseProcessFromGit(json, former))).toBe(
      "#region Prolog\r\nx = 1;\r\n#endregion\r\n#region Data\r\n#EndRegion\r\n#endregion",
    );
  });

  it("former layout: a user fold named like a later tab stays in its tab", () => {
    // There only `#endregion prolog` closes the Prolog; a bare `#endregion`
    // and `#region Epilog` are the user's.
    const ti =
      "#region prolog\na=1;\n#endregion\n#region Epilog\nc=1;\n#endregion\n#endregion prolog";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed).toMatchObject({
      prolog: "a=1;\n#endregion\n#region Epilog\nc=1;\n#endregion",
      epilog: "",
    });
    expect(toCodeBlob(ti, parsed)).toBe(
      "#region Prolog\r\na=1;\r\n#endregion\r\n#region Epilog\r\nc=1;\r\n#endregion\r\n#endregion",
    );
  });

  it("native layout: a fold not spelled exactly like TM1's tab opener stays code", () => {
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    for (const fold of ["#region data", "#region DATA", "#Region Data"]) {
      const ti = `#region Prolog\r\n${fold}\r\na=1;\r\n#endregion\r\n#endregion`;
      expect(parseProcessFromGit(json, ti).prolog).toBe(
        `${fold}\r\na=1;\r\n#endregion`,
      );
    }
    // Spelled exactly like the Data tab it cannot be told from a deleted close.
    expect(() =>
      parseProcessFromGit(
        json,
        "#region Prolog\r\n#region Data\r\na=1;\r\n#endregion\r\n#endregion",
      ),
    ).toThrow(/opens inside "prolog"/);
  });

  it("rejects tabs out of order", () => {
    const ti =
      "#region Epilog\r\ne;\r\n#endregion\r\n#region Prolog\r\np;\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/out of order/);
  });

  it("rejects a top-level #region whose name is not a recognized TI tab", () => {
    const ti = "#region NotATab\r\nsP='p';\r\n#endregion";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/#region/);
  });

  it("rejects an unbalanced #region/#endregion count", () => {
    const ti =
      "#region Prolog\r\nsP='p';\r\n#endregion\r\n#region Metadata\r\nsM='m';\r\n";
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/#region/);
  });

  it("still parses a valid multi-tab blob (with a tab omitted entirely) after structural validation is added", () => {
    const ti = makeTi({
      Prolog: "sP='p';",
      Data: "sD='d';",
      Epilog: "sE='e';",
    });
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe("sP='p';");
    expect(parsed.metadata).toBe("");
    expect(parsed.data).toBe("sD='d';");
    expect(parsed.epilog).toBe("sE='e';");
  });

  it("parses git param 'value' (native) into internal defaultValue", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const json = JSON.stringify({
      name: "P",
      hasSecurityAccess: false,
      dataSource: { type: "None" },
      parameters: [{ name: "pA", prompt: "ask", value: 7, type: "Numeric" }],
      variables: [],
    });
    expect(parseProcessFromGit(json, ti).parameters[0]).toMatchObject({
      name: "pA",
      defaultValue: 7,
      type: "Numeric",
    });
  });

  it("still parses legacy 'defaultValue' git files (param back-compat)", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const json = JSON.stringify({
      name: "P",
      parameters: [{ name: "pA", type: "String", defaultValue: "x" }],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti).parameters[0]).toMatchObject({
      name: "pA",
      defaultValue: "x",
      type: "String",
    });
  });

  it("parameters/variables/dataSource survive from json", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const { json } = serializeProcessToGit(fixture());
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.parameters.find((p) => p.name === "pNum")).toMatchObject({
      type: "Numeric",
      defaultValue: 42,
      prompt: "a number",
    });
    expect(parsed.variables.find((v) => v.name === "vCol1")).toMatchObject({
      type: "String",
      position: 1,
    });
    expect(parsed.dataSource).toMatchObject({ type: "None" });
  });

  it("ODBC password is stripped from JSON and flagged", () => {
    const serialized = serializeProcessToGit(
      fixture({
        DataSource: {
          Type: "ODBC",
          dataSourceNameForServer: "MyDSN",
          userName: "etl_user",
          password: "s3cr3t",
          query: "SELECT 1",
        },
      }),
    );
    expect(serialized.credentialsOmitted).toBe(true);
    expect(serialized.json).not.toContain("s3cr3t");
    expect(serialized.json).toContain("etl_user");
    const parsed = parseProcessFromGit(
      serialized.json,
      makeTi({ Prolog: "x=1;" }),
    );
    expect(parsed.dataSource.password).toBeUndefined();
  });

  it("no password => credentialsOmitted false", () => {
    expect(serializeProcessToGit(fixture()).credentialsOmitted).toBe(false);
  });

  it("json ends with a trailing newline", () => {
    expect(serializeProcessToGit(fixture()).json.endsWith("\n")).toBe(true);
  });

  it("invalid JSON is rejected", () => {
    expect(() =>
      parseProcessFromGit("{not json", makeTi({ Prolog: "x=1;" })),
    ).toThrow(/not valid JSON/);
  });

  it("rejects a parameter with an invalid type instead of blind-casting it", () => {
    const meta = {
      name: "P",
      parameters: [{ name: "pMonth", type: "bad", defaultValue: "1" }],
      variables: [],
      dataSource: { type: "None" },
    };
    expect(() =>
      parseProcessFromGit(JSON.stringify(meta), makeTi({ Prolog: "x=1;" })),
    ).toThrow(/invalid 'parameters'/);
  });

  it("rejects a non-array variables field", () => {
    const meta = {
      name: "P",
      parameters: [],
      variables: { not: "an array" },
      dataSource: { type: "None" },
    };
    expect(() =>
      parseProcessFromGit(JSON.stringify(meta), makeTi({ Prolog: "x=1;" })),
    ).toThrow(/invalid 'variables'/);
  });

  it("round-trips hasSecurityAccess=true", () => {
    const { json } = serializeProcessToGit(
      fixture({ HasSecurityAccess: true }),
    );
    expect(
      parseProcessFromGit(json, makeTi({ Prolog: "x=1;" })).hasSecurityAccess,
    ).toBe(true);
  });

  it("parses legacy JSON without hasSecurityAccess to undefined", () => {
    const legacy = JSON.stringify({
      name: "Old",
      parameters: [],
      variables: [],
      dataSource: { type: "None" },
    });
    expect(
      parseProcessFromGit(legacy, makeTi({ Prolog: "x=1;" })).hasSecurityAccess,
    ).toBeUndefined();
  });
});

describe("git-process ignored datasource columns", () => {
  // A column set to "Ignore" carries no variable, so `variables` alone cannot
  // represent it — leaving the UI data out made every export/import cycle drop
  // the setting.
  const UI = [
    "IgnoredInputVarName=vsOld\fVarType=32\fColType=1165\f",
    "VarType=32\fColType=827\f",
    "VarType=33\fColType=827\f",
  ];

  it("survives a json round-trip", () => {
    const { json } = serializeProcessToGit(fixture({ VariablesUIData: UI }));
    const parsed = parseProcessFromGit(json, makeTi({ Prolog: "sX='a';" }));
    expect(parsed.variablesUIData).toEqual(UI);
  });

  it("stays an empty list as the server sends it, and reads back as absent", () => {
    const { json } = serializeProcessToGit(fixture());
    expect(JSON.parse(json).VariablesUIData).toEqual([]);
    expect(
      parseProcessFromGit(json, makeTi({ Prolog: "sX='a';" })).variablesUIData,
    ).toBeUndefined();
  });

  it("rejects a json whose variablesUIData is not a list of strings", () => {
    const broken = JSON.stringify({
      name: "P",
      parameters: [],
      variables: [],
      variablesUIData: [{ ColType: 1165 }],
      dataSource: { type: "None" },
    });
    expect(() =>
      parseProcessFromGit(broken, makeTi({ Prolog: "sX='a';" })),
    ).toThrow(/variablesUIData/);
  });

  it("reads the file the VS Code extension writes (same native layout), UIData included", () => {
    const json = JSON.stringify({
      Name: "P",
      HasSecurityAccess: true,
      UIData: "CubeAction=1511\f",
      VariablesUIData: ["VarType=32\fColType=827\f"],
      DataSource: { Type: "ASCII", dataSourceNameForServer: "in.csv" },
      Parameters: [{ Name: "pA", Prompt: "", Value: "x", Type: "String" }],
      Variables: [
        { Name: "v1", Type: "String", Position: 1, StartByte: 0, EndByte: 0 },
      ],
    });
    expect(parseProcessFromGit(json, makeTi({ Prolog: "x=1;" }))).toMatchObject(
      {
        name: "P",
        hasSecurityAccess: true,
        uiData: "CubeAction=1511\f",
        variablesUIData: ["VarType=32\fColType=827\f"],
        dataSource: { type: "ASCII", dataSourceNameForServer: "in.csv" },
        parameters: [
          { name: "pA", prompt: "", defaultValue: "x", type: "String" },
        ],
        variables: [
          { name: "v1", type: "String", position: 1, startByte: 0, endByte: 0 },
        ],
      },
    );
  });

  it("rejects a file that mixes both layouts instead of reading half of it", () => {
    const json = JSON.stringify({
      Name: "P",
      parameters: [],
      Variables: [],
      DataSource: { Type: "None" },
      Parameters: [],
    });
    expect(() => parseProcessFromGit(json, makeTi({ Prolog: "x=1;" }))).toThrow(
      /unknown key\(s\): parameters/,
    );
  });

  it("rejects a data source field it would otherwise drop without a word", () => {
    const json = JSON.stringify({
      Name: "P",
      DataSource: { Type: "ASCII", asciiFancy: "x" },
      Parameters: [],
      Variables: [],
    });
    expect(() => parseProcessFromGit(json, makeTi({ Prolog: "x=1;" }))).toThrow(
      /unknown 'dataSource' key\(s\): asciiFancy/,
    );
  });

  it("rejects a .json that lacks a structural key instead of clearing it on the server", () => {
    const json = JSON.stringify({
      name: "P",
      parameters: [],
      dataSource: { type: "None" },
    });
    expect(() => parseProcessFromGit(json, makeTi({ Prolog: "x=1;" }))).toThrow(
      /missing key\(s\): variables/,
    );
  });

  it("rejects null structural keys, which would otherwise clear the server", () => {
    const native = JSON.stringify({
      Name: "P",
      DataSource: null,
      Parameters: null,
      Variables: null,
    });
    expect(() =>
      parseProcessFromGit(native, makeTi({ Prolog: "x=1;" })),
    ).toThrow(/missing key\(s\): Parameters, Variables, DataSource/);
    const legacy = JSON.stringify({
      name: "P",
      parameters: null,
      variables: [],
      dataSource: { type: "None" },
    });
    expect(() =>
      parseProcessFromGit(legacy, makeTi({ Prolog: "x=1;" })),
    ).toThrow(/missing key\(s\): parameters/);
  });

  it("rejects a .json that is not an object", () => {
    expect(() => parseProcessFromGit("[]", makeTi({ Prolog: "x=1;" }))).toThrow(
      /must be an object/,
    );
  });
});
