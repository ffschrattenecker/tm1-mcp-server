#!/usr/bin/env node
// Verify no tool declares a BARE top-level `name` input field. The toolset uses
// entity-qualified input keys (cubeName, dimensionName, processName, clientName,
// objectName, …); a lone `name` is naming drift that breaks the convention and
// confuses agents choosing arguments. This gate fails if any `server.tool(...)`
// registration under src/tools/ has a top-level `name:` key in its input schema.
//
// Nested `name` (a sub-object property — view-axis element name, chore-step
// parameter name, upsert parameter/variable name, element component name) is
// allowed: those are structural fields, not the tool's subject entity. The
// scanner only flags `name` at depth 1 of the schema object literal, so nested
// occurrences (depth >= 2) and module-level `z.object({ name })` consts defined
// outside the server.tool(...) call are never counted.
//
// Exit codes:
//   0  no tool declares a bare top-level `name` input
//   1  one or more tools declare a bare top-level `name` input
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk, TOOL_RE, toolSpans } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolsDir = join(root, "src", "tools");

// Given the source and the index of the schema object's opening `{`, return the
// list of property keys at depth 1 (direct properties of that object). Skips
// string/template literals and comments so braces inside a .describe("...{...}")
// string never throw off the brace counter.
function topLevelKeys(src, open) {
  let i = open + 1;
  let depth = 1;
  let expectKey = true; // at the start of a property slot (after `{` or a `,`)
  const keys = [];
  while (i < src.length && depth > 0) {
    const c = src[i];
    // Line comment.
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // Block comment.
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String / template literal — skip its whole body.
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      i++;
      continue;
    }
    if (depth === 1) {
      if (c === ",") {
        expectKey = true;
        i++;
        continue;
      }
      if (expectKey && /[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
        const ident = src.slice(i, j);
        let k = j;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === ":") keys.push(ident);
        expectKey = false;
        i = j;
        continue;
      }
      // Any other non-whitespace token (e.g. a `...spread`) ends the key slot.
      if (!/\s/.test(c)) expectKey = false;
    }
    i++;
  }
  return keys;
}

// Find the index of the first `{` at or after `from` that is NOT inside a
// string/template literal or comment. That is the schema object's opening brace
// — locating it naively with indexOf("{") would trip on a `{` inside the tool's
// description literal (e.g. one documenting MDX/JSON), mis-reading the
// description as the schema and false-passing. Returns -1 if none.
function findSchemaBrace(src, from) {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{") return i;
    i++;
  }
  return -1;
}

const offenders = [];

// Where the input shape starts, per registration form:
//   server.tool(name, desc, { … })  — the first `{` after name+description
//   defineTool({ …, input: { … } }) — the `{` after the `input:` key
// Both are located with findSchemaBrace so a `{` inside a description literal
// is never mistaken for the shape.
function inputBraceOf(src, span) {
  const body = src.slice(span.start, span.end);
  if (span.inline) {
    const m = /\binput:\s*\{/.exec(body);
    return m === null ? -1 : findSchemaBrace(src, span.start + m.index);
  }
  const m = new RegExp(TOOL_RE.source).exec(body);
  return m === null
    ? -1
    : findSchemaBrace(src, span.start + m.index + m[0].length);
}

for (const file of walk(toolsDir)) {
  const src = readFileSync(file, "utf8");
  for (const span of toolSpans(src)) {
    const open = inputBraceOf(src, span);
    if (open === -1) continue;
    const keys = topLevelKeys(src, open);
    if (keys.includes("name")) {
      offenders.push({ tool: span.name, file: relative(root, file) });
    }
  }
}

if (offenders.length === 0) {
  console.log(
    "check-no-bare-name-input: OK (no tool declares a bare top-level `name` input)",
  );
  process.exit(0);
}

console.error(
  `\ncheck-no-bare-name-input: ${offenders.length} tool(s) declare a bare top-level \`name\` input:\n`,
);
for (const o of offenders.sort((a, b) => a.tool.localeCompare(b.tool))) {
  console.error(`  - ${o.tool}   (${o.file})`);
}
console.error(
  `\nFix: rename the top-level input to the entity-qualified form (cubeName,\n` +
    `     dimensionName, processName, clientName, objectName, …) matching the\n` +
    `     tool's subject. Keep OUTPUT/response keys unchanged. Nested \`name\`\n` +
    `     fields (sub-object properties) are allowed.`,
);
process.exit(1);
