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
//        [--dir <connections folder>]   measure multi-connection mode instead
//        [--budget <chars>]             exit 1 when model-facing chars exceed it
// Prints one JSON summary line, then the N largest tools.
//
// `npm run lint:tool-surface-budget` runs this with a budget inside the verify
// gate, so the model-facing total cannot creep up unnoticed. Needs a current
// dist/ — verify runs it right after the output-schema gate, which builds.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode =
  args.find((a) => a === "readwrite" || a === "readonly") ?? "readwrite";
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const top = Number(flag("--top") ?? 10);
const dir = flag("--dir");
const budget =
  flag("--budget") === undefined ? undefined : Number(flag("--budget"));

// Legacy single connection (TM1_BASE_URL) unless --dir names a folder of
// connections. Either way the user's own ~/.tm1 folders are never read.
const connectionEnv = dir
  ? { TM1_CONNECTIONS_DIR: dir }
  : {
      TM1_BASE_URL: "http://127.0.0.1:1",
      TM1_USER: "measure",
      TM1_PASSWORD: "measure",
      TM1_MODE: mode,
    };
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("TM1_")),
);

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  env: { ...inherited, ...connectionEnv, TM1_LOG_LEVEL: "error" },
  stdio: ["pipe", "pipe", "ignore"],
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const timer = setTimeout(() => {
  console.error("timeout waiting for tools/list");
  child.kill();
  process.exit(1);
}, 20_000);

const len = (v) => (v === undefined ? 0 : JSON.stringify(v).length);
const modelFacing = (t) =>
  t.name.length + (t.description ?? "").length + len(t.inputSchema);

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
      const total = report(msg.result.tools);
      clearTimeout(timer);
      child.kill();
      if (budget !== undefined && total > budget) {
        console.error(
          `✗ model-facing tool surface is ${total} chars, over the ${budget} budget`,
        );
        process.exit(1);
      }
      process.exit(0);
    }
  }
});

function report(tools) {
  const sum = (f) => tools.reduce((acc, t) => acc + f(t), 0);
  const modelFacingChars = sum(modelFacing);
  console.log(
    JSON.stringify({
      mode: dir ? "connections-dir" : mode,
      tools: tools.length,
      totalChars: len(tools),
      nameChars: sum((t) => t.name.length),
      descriptionChars: sum((t) => (t.description ?? "").length),
      inputSchemaChars: sum((t) => len(t.inputSchema)),
      outputSchemaChars: sum((t) => len(t.outputSchema)),
      modelFacingChars,
    }),
  );
  const largest = tools
    .map((t) => ({ name: t.name, size: modelFacing(t) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, top);
  for (const t of largest) console.log(`${t.size}\t${t.name}`);
  return modelFacingChars;
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
