#!/usr/bin/env node
// Fail if any file under src/ re-declares its own OData escaper instead of
// importing `odataKey` / `escapeOdataLiteral` from
// src/tm1-client/services/odata-page.ts. Thirteen byte-identical copies had
// accumulated before the helpers were shared; one drifted (an extra `%27`
// pass). Import the shared helper — there is no opt-out.
//
// Exit codes:
//   0  no local escaper found
//   1  one or more local escapers found
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/scan-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const HOME = join(root, "src", "tm1-client", "services", "odata-page.ts");

// A local `enc`/`encKey`/`odataKey` binding defined as a function or arrow, or
// any encodeURIComponent wrapped around a quote-doubling replace.
const PATTERNS = [
  /\b(?:const|function)\s+(?:enc|encKey|odataKey)\b\s*(?:=\s*\(|\()/,
  /encodeURIComponent\([^)]*\.replace\(\/'\/g/,
];

const offenders = [];
for (const file of walk(join(root, "src"))) {
  if (!file.endsWith(".ts") || file === HOME) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (PATTERNS.some((re) => re.test(line))) {
      offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "Local OData escaper found — import odataKey/escapeOdataLiteral from src/tm1-client/services/odata-page.ts:",
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log("check-no-local-enc: ok");
