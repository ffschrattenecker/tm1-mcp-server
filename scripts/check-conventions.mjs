#!/usr/bin/env node
// Source-convention gates the type system cannot express. Each check scans
// src/ and reports under its own name; all run, so one failure never hides
// another.
//
//   tool-registration  every `register*` export under src/tools/ is wired into
//                      src/tools/index.ts (an unwired tool compiles and passes
//                      every other gate but is never registered at runtime)
//   input-naming       no tool declares a bare top-level `name` input; use the
//                      entity-qualified key (cubeName, processName, …). Nested
//                      `name` fields (sub-object properties) are allowed.
//   mutation-envelope  mutation tools return via actionResponse()
//                      (src/tools/format.ts) instead of hand-rolling
//                      `JSON.stringify({ success: true, ... })`
//   no-local-enc       nothing under src/ re-declares an OData escaper instead
//                      of importing odataKey / escapeOdataLiteral from
//                      src/tm1-client/services/odata-page.ts (thirteen copies
//                      had accumulated; one drifted)
//
// Exit codes:
//   0  every check passes
//   1  one or more checks failed (each failure is prefixed with its check name)
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk, toolSpans } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "src");
const toolsDir = join(srcDir, "tools");
const indexPath = join(toolsDir, "index.ts");

// Read each tool file once; every tool check below works off this list.
const toolFiles = [...walk(toolsDir)].map((file) => ({
  file,
  rel: relative(root, file),
  src: readFileSync(file, "utf8"),
}));

// ---------------------------------------------------------------------------
// tool-registration
// ---------------------------------------------------------------------------

// Two registrar forms: `export function registerX(server, tm1)` and
// `export const registerX = defineTool({...})`. The reverse direction
// (referenced but not exported) is already a compile error, and
// imported-but-not-in-REGISTRARS is an eslint no-unused-vars error.
const EXPORT_RE =
  /export\s+(?:function\s+(register[A-Za-z0-9_]+)\s*\(|const\s+(register[A-Za-z0-9_]+)\s*=)/g;

function checkToolRegistration() {
  const indexSrc = readFileSync(indexPath, "utf8");
  const missing = [];
  for (const { file, rel, src } of toolFiles) {
    if (file === indexPath) continue;
    for (const m of src.matchAll(EXPORT_RE)) {
      const name = m[1] ?? m[2];
      // Word-boundary match so registerFoo doesn't satisfy registerFooBar.
      if (!new RegExp(`\\b${name}\\b`).test(indexSrc)) {
        missing.push(`${name}   (${rel})`);
      }
    }
  }
  return {
    offenders: missing,
    problem: "tool registrar(s) exported but not wired into src/tools/index.ts",
    fix: "import the registrar and add it to the REGISTRARS array in src/tools/index.ts.",
  };
}

// ---------------------------------------------------------------------------
// input-naming
// ---------------------------------------------------------------------------

// Advance past a comment or string/template literal starting at `i`, so braces
// inside a .describe("...{...}") string never throw off a brace counter.
// Returns the index after it, or -1 when `i` starts neither.
function skipNonCode(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    while (i < src.length && src[i] !== "\n") i++;
    return i;
  }
  if (c === "/" && src[i + 1] === "*") {
    i += 2;
    while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
    return i + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    i++;
    while (i < src.length) {
      if (src[i] === "\\") i += 2;
      else if (src[i++] === c) break;
    }
    return i;
  }
  return -1;
}

// Property keys at depth 1 of the object literal whose `{` is at `open`.
function topLevelKeys(src, open) {
  let i = open + 1;
  let depth = 1;
  let expectKey = true; // at the start of a property slot (after `{` or a `,`)
  const keys = [];
  while (i < src.length && depth > 0) {
    const skipped = skipNonCode(src, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 1) {
      if (c === ",") expectKey = true;
      else if (expectKey && /[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
        let k = j;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === ":") keys.push(src.slice(i, j));
        expectKey = false;
        i = j;
        continue;
      }
      // Any other non-whitespace token (e.g. a `...spread`) ends the key slot.
      else if (!/\s/.test(c)) expectKey = false;
    }
    i++;
  }
  return keys;
}

// First `{` at or after `from` outside strings/comments — a naive indexOf
// would trip on a `{` inside the tool's description literal and false-pass.
function findCodeBrace(src, from) {
  let i = from;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    if (src[i] === "{") return i;
    i++;
  }
  return -1;
}

function checkInputNaming() {
  const offenders = [];
  for (const { rel, src } of toolFiles) {
    for (const span of toolSpans(src)) {
      const m = /\binput:\s*\{/.exec(src.slice(span.start, span.end));
      if (m === null) continue;
      const open = findCodeBrace(src, span.start + m.index);
      if (open !== -1 && topLevelKeys(src, open).includes("name")) {
        offenders.push(`${span.name}   (${rel})`);
      }
    }
  }
  return {
    offenders,
    problem: "tool(s) declare a bare top-level `name` input",
    fix: "rename the input to the entity-qualified form (cubeName, dimensionName, processName, clientName, objectName, …). Keep OUTPUT keys unchanged.",
  };
}

// ---------------------------------------------------------------------------
// mutation-envelope
// ---------------------------------------------------------------------------

// Files deliberately allowed to hand-roll their success envelope. EMPTY today;
// add an entry ONLY with a comment explaining why actionResponse() cannot
// express that tool's exact payload.
const ENVELOPE_ALLOWLIST = new Set([
  // "src/tools/<category>/<tool>.ts", // reason the helper can't reproduce it
]);

// `success: true` as the first key after the opening brace, direct or via a
// const that is later stringified.
const DIRECT_RE = /JSON\.stringify\(\s*\{\s*success\s*:\s*true\b/;
const VAR_DECL_RE = /const\s+([A-Za-z0-9_$]+)\s*=\s*\{\s*success\s*:\s*true\b/g;

function checkMutationEnvelope() {
  const offenders = [];
  for (const { rel, src } of toolFiles) {
    if (ENVELOPE_ALLOWLIST.has(rel.split("\\").join("/"))) continue;
    if (DIRECT_RE.test(src)) {
      offenders.push(`${rel}   (JSON.stringify({ success: true, ... }))`);
      continue;
    }
    for (const m of src.matchAll(VAR_DECL_RE)) {
      const name = m[1];
      if (new RegExp(`JSON\\.stringify\\(\\s*${name}\\s*\\)`).test(src)) {
        offenders.push(
          `${rel}   (JSON.stringify(${name}) of a success object)`,
        );
        break;
      }
    }
  }
  return {
    offenders,
    problem: "mutation tool(s) hand-roll the success envelope",
    fix: "`return actionResponse({ success: true, ... });` from src/tools/format.js, or add the file to ENVELOPE_ALLOWLIST with a reason.",
  };
}

// ---------------------------------------------------------------------------
// no-local-enc
// ---------------------------------------------------------------------------

const ENC_HOME = join(srcDir, "tm1-client", "services", "odata-page.ts");
// A local `enc`/`encKey`/`odataKey` function or arrow, or any
// encodeURIComponent wrapped around a quote-doubling replace.
const ENC_PATTERNS = [
  /\b(?:const|function)\s+(?:enc|encKey|odataKey)\b\s*(?:=\s*\(|\()/,
  /encodeURIComponent\([^)]*\.replace\(\/'\/g/,
];

function checkNoLocalEnc() {
  const offenders = [];
  for (const file of walk(srcDir)) {
    if (file === ENC_HOME) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (ENC_PATTERNS.some((re) => re.test(line))) {
          offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  return {
    offenders,
    problem: "local OData escaper(s) found",
    fix: "import odataKey / escapeOdataLiteral from src/tm1-client/services/odata-page.ts.",
  };
}

// ---------------------------------------------------------------------------

const CHECKS = {
  "tool-registration": checkToolRegistration,
  "input-naming": checkInputNaming,
  "mutation-envelope": checkMutationEnvelope,
  "no-local-enc": checkNoLocalEnc,
};

let failed = 0;
for (const [name, check] of Object.entries(CHECKS)) {
  const { offenders, problem, fix } = check();
  if (offenders.length === 0) {
    console.log(`check-conventions [${name}]: OK`);
    continue;
  }
  failed++;
  console.error(
    `\ncheck-conventions [${name}]: ${offenders.length} ${problem}:`,
  );
  for (const o of offenders.sort()) console.error(`  - ${o}`);
  console.error(`  Fix: ${fix}\n`);
}
process.exit(failed === 0 ? 0 : 1);
