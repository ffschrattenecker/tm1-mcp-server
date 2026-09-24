// Shared scanner for tool declarations under src/tools/**/*.ts. Used by
// gen-tool-list.mjs and check-no-bare-name-input.mjs.
//
// Every tool is declared the same way:
//
//   export const registerX = defineTool({
//     name: "tm1_x",
//     description: "…" | [ "…", "…" ] | [ … ].join("sep"),
//     input: { … },
//     …
//   })
//
// Annotations and output schema live in the same literal, which is why the
// map-sync gates this file used to feed are gone: the TypeScript type is the
// only thing that has to agree with the code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

export const DEFINE_TOOL_RE = /defineTool\(\{/g;

const STRING_LITERAL_RE = /"((?:[^"\\]|\\.)*)"/g;
const NAME_KEY_RE = /\bname:\s*"(tm1_[a-z0-9_]+)"/;
const DESC_STRING_RE = /\bdescription:\s*"((?:[^"\\]|\\.)*)"/;
// Array form, with or without a trailing `.join("sep")`.
const DESC_ARRAY_RE =
  /\bdescription:\s*\[([\s\S]*?)\n\s*\](?:\s*\.join\(\s*"((?:[^"\\]|\\.)*)"\s*\))?\s*,/;

function joinStringLiterals(body, sep) {
  const parts = [];
  let m;
  const re = new RegExp(STRING_LITERAL_RE.source, "g");
  while ((m = re.exec(body)) !== null) parts.push(m[1]);
  return parts.join(sep);
}

// Source span of one declaration: from its `defineTool({` to the start of the
// next one (or EOF). Callers that need per-tool attribution — the bare-`name`
// input gate — slice on these.
export function toolSpans(src) {
  const spans = [];
  const re = new RegExp(DEFINE_TOOL_RE.source, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = (NAME_KEY_RE.exec(src.slice(m.index, m.index + 4000)) ??
      [])[1];
    if (name) spans.push({ name, start: m.index });
  }
  for (let i = 0; i < spans.length; i++) {
    spans[i].end = i + 1 < spans.length ? spans[i + 1].start : src.length;
  }
  return spans;
}

export function scanTools(toolsDir) {
  const tools = [];
  for (const file of walk(toolsDir)) {
    const src = readFileSync(file, "utf8");
    const rel = relative(toolsDir, file);
    // Either separator: path.relative() answers with \ on Windows.
    const group = rel.split(/[\\/]/)[0];

    for (const span of toolSpans(src)) {
      const body = src.slice(span.start, span.end);
      const asString = DESC_STRING_RE.exec(body);
      const asArray = DESC_ARRAY_RE.exec(body);
      const desc = asString
        ? asString[1]
        : asArray
          ? joinStringLiterals(asArray[1], asArray[2] ?? " ")
          : "";
      tools.push({ name: span.name, desc, file: rel, group });
    }
  }
  return tools;
}
