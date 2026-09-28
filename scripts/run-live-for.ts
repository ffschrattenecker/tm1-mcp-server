#!/usr/bin/env tsx
/**
 * Run live suites against ONE connection folder (~/.tm1/mcp-servers/<name>/,
 * or TM1_CONNECTIONS_DIR), with exactly the environment the MCP server builds
 * for that connection.
 *
 *   npm run test:live:for -- <connection> [vitest args…]
 *   npm run test:live:for -- tm1-plapp-franz tests/live/cube.live.test.ts
 *
 * Built after a hand-rolled .env loader sent a mangled password and a
 * five-file run locked the account (TM1 MaximumLoginAttempts). Three guards:
 *
 *   1. The .env is read through connectionEnv() — the server's own dotenv
 *      parse and TM1_* isolation — never a second parser.
 *   2. ONE login probe runs first; vitest starts only if it succeeds. Every
 *      live file logs in on its own, so a bad password would otherwise cost
 *      one failed login per file.
 *   3. A REFUSED probe (401/403) leaves .live-reports/<connection>.auth-failed.log,
 *      which blocks further runs for that connection until --retry-login is
 *      passed. Nothing retries a login by itself.
 *
 * A TM1_SECRETS=keychain folder gets its secrets from the OS keychain, as in
 * the server; vitest inherits them through its environment, since every live
 * file builds its config from process.env.
 *
 * Exit codes: vitest's own; 2 usage / unknown connection; 3 login refused or
 * blocked by an earlier refusal.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../src/config.js";
import { connectionEnv, connectionsDir } from "../src/connections.js";
import { usesKeychain, withKeychainSecrets } from "../src/secrets.js";
import { SessionManager } from "../src/session-manager.js";

const REPORT_DIR = ".live-reports";

function usage(message: string): never {
  console.error(message);
  console.error(
    "usage: npm run test:live:for -- <connection> [--retry-login] [vitest args…]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const retryLogin = args.includes("--retry-login");
  const rest = args.filter((a) => a !== "--retry-login");
  const name = rest.shift();
  if (!name || name.startsWith("-")) usage("missing <connection>");

  const dir = connectionsDir(process.env);
  const folder = join(dir, name);
  if (!existsSync(join(folder, ".env"))) {
    usage(`no connection '${name}': ${join(folder, ".env")} does not exist`);
  }

  const marker = join(REPORT_DIR, `${name}.auth-failed.log`);
  if (existsSync(marker) && !retryLogin) {
    console.error(
      `refusing to run: the last login to '${name}' was refused (${marker}).\n` +
        "Another failed login may lock the account. Fix the credentials or get\n" +
        "the account re-enabled, then pass --retry-login once.",
    );
    process.exit(3);
  }

  let env = connectionEnv(folder, process.env);
  if (usesKeychain(env)) env = await withKeychainSecrets(name, env);
  const config = loadConfig(env);
  console.log(
    `connection: ${name}  ${config.baseUrl}  v${config.version}  user=${env.TM1_USER ?? "?"}`,
  );

  // Exactly one login attempt: authenticate() makes a single request and
  // never retries on its own.
  const sessions = new SessionManager(config, pino({ level: "silent" }));
  try {
    await sessions.authenticate();
    await sessions.logout();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only a refused login counts toward a lockout; a server that is down or
    // unreachable never saw the credentials, so it leaves no marker.
    if (/status (401|403)\b/.test(message)) {
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(marker, `${new Date().toISOString()} ${message}\n`);
    }
    console.error(`login probe failed: ${message}\nnot running any tests.`);
    process.exit(3);
  }
  rmSync(marker, { force: true });

  // No shell: the vitest entry point is spawned directly with node.
  const run = spawnSync(
    process.execPath,
    [
      join("node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.live.config.ts",
      ...rest,
    ],
    { env, stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}

void main();
