// Guard against the duplication that #2 of the maintainability review removed:
// a wire shape written once as a TypeScript interface in src/types.ts and again
// as a Zod object in src/tools/schemas/. That is how `lockType` and
// `oDBCConnection` survived for months — the two definitions had no link, so
// removing a field from one left the other intact.
//
// The rule now: a shape both layers need is defined once in src/schemas/ as
// Zod, and the type is `z.infer` of it. This test fails when a new interface
// appears in types.ts whose name matches a Zod schema in the tool layer.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = join(process.cwd(), "src");

// Shapes where the two definitions describe genuinely different payloads —
// see the note above the declarations in src/types.ts.
const ALLOWED_DIVERGENT = new Set([
  "MdxResult",
  "ViewResult",
  "CubeRules",
  "ServerInfo",
]);

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
}

function interfaceNames(path: string): string[] {
  return parse(path)
    .statements.filter(ts.isInterfaceDeclaration)
    .map((s) => s.name.getText());
}

// Base names of Zod object schemas declared (not re-exported) in the tool
// schema files: `CubeItemSchema` and `CubeSchema` both yield "Cube".
function toolSchemaBaseNames(): Set<string> {
  const names = new Set<string>();
  const dir = join(SRC, "tools", "schemas");
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("items-")) continue;
    for (const st of parse(join(dir, file)).statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const decl of st.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (!/^z\s*\.object/.test(decl.initializer.getText())) continue;
        const m = /^(.*?)(?:Item)?Schema$/.exec(decl.name.getText());
        if (m?.[1]) names.add(m[1]);
      }
    }
  }
  return names;
}

describe("one definition per wire shape", () => {
  it("no interface in types.ts duplicates a hand-written tool schema", () => {
    const duplicated = interfaceNames(join(SRC, "types.ts"))
      .filter((n) => toolSchemaBaseNames().has(n))
      .filter((n) => !ALLOWED_DIVERGENT.has(n));

    expect(
      duplicated,
      "define the shape once in src/schemas/ and derive the type with z.infer, " +
        "or add it to ALLOWED_DIVERGENT with a note saying why the payloads differ",
    ).toEqual([]);
  });

  it("src/schemas stays below both consumers", () => {
    const dir = join(SRC, "schemas");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), "utf8");
      if (/from "\.\.\/(tools|tm1-client|types)/.test(src))
        offenders.push(file);
    }
    expect(
      offenders,
      "src/schemas/ must not import from the layers that consume it",
    ).toEqual([]);
  });
});
