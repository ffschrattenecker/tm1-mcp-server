import { describe, it, expect } from "vitest";
import {
  ASSIGNMENT_RE,
  SECTION_MARKER_RE,
  callArgs,
  matchParen,
  quotedLiteral,
  splitTopLevel,
  truncateSnippet,
} from "../../src/lib/ti-lex.js";
import { parseTiCode } from "../../src/lib/callgraph/tiParser.js";
import { extractTiReferences } from "../../src/lib/callgraph/referenceIndex.js";
import { extractSubsetUsage } from "../../src/lib/callgraph/subsetUsage.js";
import { buildProcessEnv } from "../../src/lib/callgraph/variableEnv.js";
import { extractDbCalls } from "../../src/lib/callgraph/rulesLinter.js";

describe("splitTopLevel", () => {
  it("splits on the separator at depth 0 and trims the pieces", () => {
    expect(splitTopLevel("a , b,c", ",")).toEqual(["a", "b", "c"]);
  });

  it("does not split inside nested parens", () => {
    expect(splitTopLevel("f(a,b), c", ",")).toEqual(["f(a,b)", "c"]);
    expect(splitTopLevel("f(g(a,b),c),d", ",")).toEqual(["f(g(a,b),c)", "d"]);
  });

  it("splits on ';' and '|' as well as ','", () => {
    expect(splitTopLevel("a = 1; b = 2", ";")).toEqual(["a = 1", "b = 2"]);
    expect(splitTopLevel("'a' | f(x) | 'b'", "|")).toEqual([
      "'a'",
      "f(x)",
      "'b'",
    ]);
  });

  it("ignores separators inside string literals", () => {
    expect(splitTopLevel("'a;b';c", ";")).toEqual(["'a;b'", "c"]);
    expect(splitTopLevel("'x,y', 2", ",")).toEqual(["'x,y'", "2"]);
  });

  it("ignores parens inside string literals", () => {
    expect(splitTopLevel("s @= ')', 2", ",")).toEqual(["s @= ')'", "2"]);
    expect(splitTopLevel("'(', 'a'", ",")).toEqual(["'('", "'a'"]);
  });

  it("treats '' inside a literal as an escaped quote", () => {
    expect(splitTopLevel("'it''s,x', y", ",")).toEqual(["'it''s,x'", "y"]);
    expect(splitTopLevel("'it''', y", ",")).toEqual(["'it'''", "y"]);
  });

  it("treats a double quote as an ordinary character", () => {
    expect(splitTopLevel('x"y, z', ",")).toEqual(['x"y', "z"]);
    expect(splitTopLevel('"a, b"', ",")).toEqual(['"a', 'b"']);
  });

  it("keeps interior empty pieces and drops a trailing empty piece", () => {
    expect(splitTopLevel("a,,b", ",")).toEqual(["a", "", "b"]);
    expect(splitTopLevel(",a", ",")).toEqual(["", "a"]);
    expect(splitTopLevel("a,", ",")).toEqual(["a"]);
  });

  it("returns no pieces for blank text", () => {
    expect(splitTopLevel("", ",")).toEqual([]);
    expect(splitTopLevel("   ", ",")).toEqual([]);
  });

  it("splits on commas inside braces when asked for the brace pair", () => {
    expect(splitTopLevel("'D':{'a','b'}, 'E':'x'", ",", "{}")).toEqual([
      "'D':{'a','b'}",
      "'E':'x'",
    ]);
    // Parens are not nesting in brace mode.
    expect(splitTopLevel("f(a,b)", ",", "{}")).toEqual(["f(a", "b)"]);
  });

  it("does not split on an unclosed quote's remainder", () => {
    // Unterminated literal ends at end of line, so the rest is one piece.
    expect(splitTopLevel("'abc, d", ",")).toEqual(["'abc, d"]);
  });
});

describe("matchParen", () => {
  it("returns the index of the ')' matching the '(' at openIdx", () => {
    expect(matchParen("f(a)", 1)).toBe(3);
    expect(matchParen("f(g(a), b) + 1", 1)).toBe(9);
  });

  it("ignores parens inside string literals", () => {
    expect(matchParen("f(')')", 1)).toBe(5);
    expect(matchParen("f('(' , ')')", 1)).toBe(11);
  });

  it("honours '' escapes inside a literal", () => {
    expect(matchParen("f('it''s)')", 1)).toBe(10);
  });

  it("returns -1 for an unbalanced call", () => {
    expect(matchParen("f(a, (b)", 1)).toBe(-1);
    expect(matchParen("f('abc)", 1)).toBe(-1);
  });

  it("stops at limit (exclusive) when given", () => {
    expect(matchParen("f(abc)", 1, 5)).toBe(-1);
    expect(matchParen("f(abc)", 1, 6)).toBe(5);
  });
});

describe("callArgs", () => {
  it("returns the raw top-level argument texts", () => {
    expect(callArgs("f(a, 'b,c', g(1,2))", 1)).toEqual([
      "a",
      " 'b,c'",
      " g(1,2)",
    ]);
  });

  it("returns one empty argument for an empty call", () => {
    expect(callArgs("f()", 1)).toEqual([""]);
  });

  it("keeps empty positional arguments", () => {
    expect(callArgs("f(a,,b,)", 1)).toEqual(["a", "", "b", ""]);
  });

  it("returns null for an unterminated call", () => {
    expect(callArgs("f(a, b", 1)).toBeNull();
  });

  it("closes an unterminated string at end of line so the call resyncs", () => {
    expect(callArgs("f('abc\nx, 2)", 1)).toEqual(["'abc\nx", " 2"]);
  });

  it("gives up after 2000 characters", () => {
    expect(callArgs(`f(${"x".repeat(1500)})`, 1)).not.toBeNull();
    expect(callArgs(`f(${"x".repeat(2500)})`, 1)).toBeNull();
  });
});

describe("quotedLiteral", () => {
  it("returns the value of a single string literal", () => {
    expect(quotedLiteral("'abc'")).toBe("abc");
    expect(quotedLiteral("  'a b'  ")).toBe("a b");
  });

  it("unescapes '' to '", () => {
    expect(quotedLiteral("'it''s'")).toBe("it's");
    expect(quotedLiteral("'''")).toBeNull();
    expect(quotedLiteral("''''")).toBe("'");
  });

  it("returns the empty string for ''", () => {
    expect(quotedLiteral("''")).toBe("");
  });

  it("returns null for anything that is not one literal", () => {
    expect(quotedLiteral("abc")).toBeNull();
    expect(quotedLiteral("'a' 'b'")).toBeNull();
    expect(quotedLiteral("'a'b'")).toBeNull();
    expect(quotedLiteral("'a")).toBeNull();
    expect(quotedLiteral('"a"')).toBeNull();
  });
});

describe("shared regexes", () => {
  it("SECTION_MARKER_RE matches TI section markers only", () => {
    expect(SECTION_MARKER_RE.test("572,")).toBe(true);
    expect(SECTION_MARKER_RE.test("574,12")).toBe(true);
    expect(SECTION_MARKER_RE.test("571,")).toBe(false);
    expect(SECTION_MARKER_RE.test("572")).toBe(false);
  });

  it("ASSIGNMENT_RE captures variable and right-hand side", () => {
    const m = ASSIGNMENT_RE.exec("  sX = 'a' ; # note");
    expect(m?.[1]).toBe("sX");
    expect(m?.[2]).toBe("'a'");
  });
});

describe("truncateSnippet", () => {
  it("trims and keeps short text whole", () => {
    expect(truncateSnippet("  x = 1;  ", 200)).toBe("x = 1;");
  });

  it("cuts long text so the result, ellipsis included, is at most max", () => {
    const out = truncateSnippet("a".repeat(300), 200);
    expect(out.length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("intended behaviour changes", () => {
  it("IF condition: a ')' inside a literal does not end the condition", () => {
    const r = parseTiCode("IF(sX = ')');\n  a = 1;\nENDIF;");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.ast[0];
    expect(block?.type).toBe("if");
    if (block?.type !== "if") return;
    expect(block.condition).toBe("sX = ')'");
    expect(block.thenBody).toHaveLength(1);
  });

  it("single-line IF with a ')' in a literal parses as one statement", () => {
    const r = parseTiCode("IF(sX = ')'); a = 1; ENDIF;");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.ast[0];
    expect(block?.type).toBe("if");
    if (block?.type !== "if") return;
    expect(block.condition).toBe("sX = ')'");
    expect(block.thenBody).toHaveLength(1);
  });

  it("function call: a ')' inside a literal does not end the argument list", () => {
    const r = parseTiCode("ExecuteProcess('a)b', 'x', 1);");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const call = r.ast[0];
    expect(call?.type).toBe("functionCall");
    if (call?.type !== "functionCall") return;
    expect(call.args).toEqual(["'a)b'", "'x'", "1"]);
  });

  it("function call: a '\"' is an ordinary character, not a string delimiter", () => {
    const r = parseTiCode("x = CellGetS('Sales', x\"y, 'Jan');");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.ast[0];
    expect(a?.type).toBe("assignment");
    if (a?.type !== "assignment") return;
    expect(a.cellGetInfo?.params).toEqual(["'Sales'", 'x"y', "'Jan'"]);
  });

  it("extractTiReferences: '' inside a process name is an escaped quote", () => {
    const refs = extractTiReferences("ExecuteProcess('it''s');");
    expect(refs.map((r) => r.targetName)).toEqual(["it's"]);
  });

  it("subset usage: a ')' inside a literal does not cut the call's arguments", () => {
    const usage = extractSubsetUsage(
      "ViewSubsetAssign('Sales', 'Vi)ew', 'Dim', 'Jan');",
    );
    expect(usage.get("jan")).toMatchObject({
      subset: "Jan",
      resolved: true,
    });
  });

  it("variable env: '' inside a literal is an escaped quote", () => {
    const env = buildProcessEnv("sX = 'it''s';", []);
    expect(env.vars.get("sx")).toEqual({ kind: "literal", value: "it's" });
  });

  it("variable env: '' alone is the empty literal", () => {
    const env = buildProcessEnv("sX = '';", []);
    expect(env.vars.get("sx")).toEqual({ kind: "literal", value: "" });
  });

  it("DB(): '' inside the cube name is an escaped quote", () => {
    const calls = extractDbCalls("x = DB('a''b', 'E');");
    expect(calls.map((c) => c.cubeName)).toEqual(["a'b"]);
  });
});
