#!/usr/bin/env node
// Records wire contracts by running the live suite against a named server
// with RECORD_CONTRACTS=1.
//
// The server is named explicitly — an .mcp.json entry or a connection folder —
// never taken from the repo's .env: .env may point at a production instance,
// and the live suite creates and deletes sandbox objects. Refusing to guess is
// the whole point of this wrapper.
//
//   node scripts/record-wire-contracts.mjs [serverName] [--replace] [--read-only]
//   node scripts/record-wire-contracts.mjs --connection=<name> [--replace] ...
//
//   --connection=<name>  take the server from ~/.tm1/mcp-servers/<name>/.env
//                (or TM1_CONNECTIONS_DIR) instead of an .mcp.json entry. Runs
//                through scripts/run-live-for.ts, so the .env is read the way
//                the server reads it, TM1_SECRETS=keychain folders get their
//                secrets from the OS keychain, and one login probe runs first.
//   --replace    start the contracts over from this run alone, discarding
//                what is on disk. The default is to merge, because a run only
//                ever observes the shapes its target happens to hold: recording
//                over the file drops every endpoint this run did not reach and
//                narrows every union it did not re-observe, and nothing turns
//                red afterwards. Use it only for a deliberate fresh start,
//                such as a new server version, and read the diff. (--merge is
//                still accepted; it is the default now.)
//   --read-only  run only the read-only sweep, so the target server is never
//                written to. Required in practice for anything but a test
//                instance.
//   --verify     do not record — run the live suite and fail if the server no
//                longer matches the contracts on disk.
//
// Default server: tm1-test.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const connection = args
  .find((a) => a.startsWith("--connection="))
  ?.slice("--connection=".length);
const name = connection ?? args.find((a) => !a.startsWith("--")) ?? "tm1-test";
const readOnly = flags.has("--read-only");

function fromConnectionFolder(conn) {
  const dir =
    process.env.TM1_CONNECTIONS_DIR ?? join(homedir(), ".tm1", "mcp-servers");
  const file = join(dir, conn, ".env");
  if (!existsSync(file)) return undefined;
  return { env: parse(readFileSync(file, "utf8")) };
}

function fromMcpJson(server) {
  const file = join(root, ".mcp.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")).mcpServers?.[server];
}

const entry = connection ? fromConnectionFolder(connection) : fromMcpJson(name);
if (!entry?.env?.TM1_BASE_URL) {
  console.error(
    connection
      ? `record-wire-contracts: no connection "${name}" with TM1_BASE_URL under ~/.tm1/mcp-servers (or TM1_CONNECTIONS_DIR)`
      : `record-wire-contracts: no server "${name}" with TM1_BASE_URL in .mcp.json`,
  );
  process.exit(1);
}
// An .mcp.json entry's env goes to vitest as-is, and the keychain is keyed by
// connection folder, so only --connection can resolve TM1_SECRETS. Fail here
// rather than let every live file miss TM1_PASSWORD.
if (!connection && entry.env.TM1_SECRETS) {
  console.error(
    `record-wire-contracts: "${name}" keeps its secrets in the OS keychain (TM1_SECRETS); ` +
      `name its connection folder instead: --connection=<name>`,
  );
  process.exit(1);
}

console.log(
  `${flags.has("--verify") ? "Checking" : "Recording"} wire contracts against "${name}" (${entry.env.TM1_BASE_URL})` +
    (flags.has("--verify") ? " — verifying, not recording" : "") +
    (readOnly
      ? " — read-only sweep"
      : " — full live suite (creates sandbox objects)") +
    (flags.has("--verify")
      ? ""
      : flags.has("--replace")
        ? " — REPLACING the contracts on disk"
        : " — merging into the contracts on disk"),
);

const target = readOnly
  ? ["tests/live/read-broad.live.test.ts", "tests/live/read-smoke.live.test.ts"]
  : [];

const modeEnv = {
  ...(flags.has("--verify") ? {} : { RECORD_CONTRACTS: "1" }),
  ...(flags.has("--replace") ? {} : { CONTRACTS_MERGE: "1" }),
};

// Entry points through this node, not `npx`: on Windows npx is npx.cmd,
// which spawnSync cannot start without a shell. run-live-for builds the
// connection's env itself and passes the rest of process.env (modeEnv) on.
const res = connection
  ? spawnSync(
      process.execPath,
      [
        join(root, "node_modules", "tsx", "dist", "cli.mjs"),
        join(root, "scripts", "run-live-for.ts"),
        connection,
        ...target,
      ],
      { cwd: root, stdio: "inherit", env: { ...process.env, ...modeEnv } },
    )
  : spawnSync(
      process.execPath,
      [
        join(root, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        "vitest.live.config.ts",
        ...target,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, ...entry.env, ...modeEnv },
      },
    );
if (res.error) {
  console.error(
    `record-wire-contracts: could not start vitest: ${res.error.message}`,
  );
  process.exit(1);
}
// The live suite has known per-version failures; a failing assertion still
// produced real responses, so a non-zero exit does not invalidate the
// recording. Surface the code without treating it as fatal.
// run-live-for exits 2 (usage) or 3 (login refused) before any test runs, so
// nothing was recorded.
if (connection && (res.status === 2 || res.status === 3)) {
  process.exit(res.status);
}
if (res.status !== 0) {
  console.log(
    `\nlive suite exited ${res.status} — contracts recorded from whatever ran.`,
  );
}
