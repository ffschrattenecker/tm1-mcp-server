// Shared scanner for tool registrations under src/tools/**/*.ts. Used by
// gen-tool-list.mjs, check-annotation-coverage.mjs, check-markdown-schema-
// coverage.mjs and check-no-bare-name-input.mjs.
//
// Two registration forms exist while the defineTool migration runs:
//
//   server.tool("tm1_x", "desc", { ...input }, cb)     — legacy; annotation and
//     outputSchema live in the name-keyed maps, which the gates police.
//
//   export const registerX = defineTool({                — migrated; annotation
//     name: "tm1_x", description: [...], input: {...} })   and outputSchema are
//     part of the literal, so the TS type is the gate and the map-sync checks
//     do not apply. Scanned entries carry `inline: true`.
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

// Match either:
//   server.tool("name", "desc", ...)
//   server.tool("name", [ "line1", "line2" ].join("..."), ...)
export const TOOL_RE =
  /server\.tool\(\s*"([^"]+)"\s*,\s*(?:"((?:[^"\\]|\\.)*)"|\[([\s\S]*?)\]\s*\.join\(\s*"((?:[^"\\]|\\.)*)"\s*\))/g;

// Match a defineTool({ name: "...", description: "..." | [ ... ] }) header.
// Key order inside the literal is free; both keys are required by ToolSpec, so
// a miss here means the file does not compile.
export const DEFINE_TOOL_RE = /defineTool\(\{/g;

const STRING_LITERAL_RE = /"((?:[^"\\]|\\.)*)"/g;
const NAME_KEY_RE = /\bname:\s*"(tm1_[a-z0-9_]+)"/;
const DESC_STRING_RE = /\bdescription:\s*"((?:[^"\\]|\\.)*)"/;
const DESC_ARRAY_RE = /\bdescription:\s*\[([\s\S]*?)\n\s*\],/;

function joinStringLiterals(body, sep) {
  const parts = [];
  let m;
  const re = new RegExp(STRING_LITERAL_RE.source, "g");
  while ((m = re.exec(body)) !== null) parts.push(m[1]);
  return parts.join(sep);
}

// Source span of one registration: from its opening marker to the start of the
// next one (or EOF). Callers that need per-registration attribution — the
// markdown and bare-`name` gates — slice on these.
export function toolSpans(src) {
  const spans = [];
  for (const re of [
    new RegExp(TOOL_RE.source, "g"),
    new RegExp(DEFINE_TOOL_RE.source, "g"),
  ]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const inline = re.source === DEFINE_TOOL_RE.source;
      const name = inline
        ? (NAME_KEY_RE.exec(src.slice(m.index, m.index + 4000)) ?? [])[1]
        : m[1];
      if (name) spans.push({ name, start: m.index, inline });
    }
  }
  spans.sort((a, b) => a.start - b.start);
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
    const group = rel.split("/")[0];

    for (const span of toolSpans(src)) {
      const body = src.slice(span.start, span.end);
      let desc;
      if (span.inline) {
        const asString = DESC_STRING_RE.exec(body);
        const asArray = DESC_ARRAY_RE.exec(body);
        desc = asString
          ? asString[1]
          : asArray
            ? joinStringLiterals(asArray[1], " ")
            : "";
      } else {
        const m = new RegExp(TOOL_RE.source).exec(body);
        desc = m
          ? m[2] !== undefined
            ? m[2]
            : joinStringLiterals(m[3], m[4])
          : "";
      }
      tools.push({
        name: span.name,
        desc,
        file: rel,
        group,
        inline: span.inline,
      });
    }
  }
  return tools;
}
