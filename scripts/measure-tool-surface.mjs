#!/usr/bin/env node
// Measure what tools/list actually ships, per section.
//
// Spawns the BUILT server (dist/index.js) against an unreachable TM1 URL — the
// server lists tools without a live connection — and reports tool count plus
// the serialized size of names, descriptions, input schemas and output
// schemas. Input schema + description are what a model pays for once a tool
// is loaded; output schemas are client-side only in Claude Code.
//
// Usage: node scripts/measure-tool-surface.mjs [readwrite|readonly] [--top N]
// Prints one JSON summary line, then the N largest tools.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode =
  args.find((a) => a === "readwrite" || a === "readonly") ?? "readwrite";
const topIdx = args.indexOf("--top");
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 10;

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  env: {
    ...process.env,
    TM1_BASE_URL: "http://127.0.0.1:1",
    TM1_USER: "measure",
    TM1_PASSWORD: "measure",
    TM1_MODE: mode,
    TM1_LOG_LEVEL: "silent",
    // Keep the measurement independent of the user's connection folders.
    TM1_CONNECTIONS_DIR: join(root, ".no-connections"),
  },
  stdio: ["pipe", "pipe", "ignore"],
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const timer = setTimeout(() => {
  console.error("timeout waiting for tools/list");
  child.kill();
  process.exit(1);
}, 20_000);

const len = (v) => (v === undefined ? 0 : JSON.stringify(v).length);

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (msg.id === 2) {
      report(msg.result.tools);
      clearTimeout(timer);
      child.kill();
      process.exit(0);
    }
  }
});

function report(tools) {
  const sum = (f) => tools.reduce((acc, t) => acc + f(t), 0);
  console.log(
    JSON.stringify({
      mode,
      tools: tools.length,
      totalChars: len(tools),
      nameChars: sum((t) => t.name.length),
      descriptionChars: sum((t) => (t.description ?? "").length),
      inputSchemaChars: sum((t) => len(t.inputSchema)),
      outputSchemaChars: sum((t) => len(t.outputSchema)),
      modelFacingChars: sum(
        (t) =>
          t.name.length + (t.description ?? "").length + len(t.inputSchema),
      ),
    }),
  );
  const largest = tools
    .map((t) => ({
      name: t.name,
      modelFacing:
        t.name.length + (t.description ?? "").length + len(t.inputSchema),
    }))
    .sort((a, b) => b.modelFacing - a.modelFacing)
    .slice(0, top);
  for (const t of largest) console.log(`${t.modelFacing}\t${t.name}`);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "measure-tool-surface", version: "0" },
  },
});
