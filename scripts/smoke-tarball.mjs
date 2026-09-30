#!/usr/bin/env node
// Tarball smoke test — the only check in this repo that exercises the artefact
// a user actually installs.
//
// `npm run verify` and the live suite run against the TypeScript SOURCE; neither
// loads `dist/` or the packed tarball (bin wiring, shebang, `files` allow-list,
// the compiled entrypoint's startup path). This script packs the real tarball,
// installs it into a throwaway project under os.tmpdir(), asserts the bin entry
// resolves to dist/index.js, asserts the shebang, asserts no secrets/sources
// leaked into the tarball, then starts the binary with NO TM1 configuration and
// asserts it dies with a readable configuration error instead of a hang.
//
// Not part of `npm run verify` (it packs, builds and hits the npm registry);
// CI and the publish workflow run it, and RELEASING.md lists it.
//
//   npm run smoke:tarball
//
// Exit codes: 0 passed · 1 installed artefact broken · 2 usage error ·
// 4 pack or install failed (nothing to test).
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const EXIT_OK = 0;
const EXIT_TIER1 = 1;
const EXIT_USAGE = 2;
const EXIT_PACK = 4;

// Tar entries that must never appear inside the published tarball (npm prefixes
// every path with `package/`). `files` in package.json already restricts the
// contents to dist/ — this asserts the restriction actually held, because a
// broken `files` entry is how credentials reach the registry.
const FORBIDDEN_IN_TARBALL = [
  /^package\/\.env/,
  /^package\/\.mcp\.json$/,
  /^package\/\.npmrc$/,
  /^package\/src\//,
  /^package\/tests\//,
  /\.map$/,
  /\.d\.ts$/,
];

// ---------------------------------------------------------------- arguments

function usage() {
  process.stdout.write(
    `Usage: node scripts/smoke-tarball.mjs [options]

  --pack-timeout=SEC    npm pack budget (default: 300).
  --install-timeout=SEC npm install budget (default: 300).
  --start-timeout=SEC   No-config start budget (default: 30).
  --keep-tmp            Leave the throwaway install dir behind (debugging only).
  -h, --help            This text.
`,
  );
}

function parseArgs(argv) {
  const opts = {
    packTimeoutSec: 300,
    installTimeoutSec: 300,
    startTimeoutSec: 30,
    keepTmp: false,
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");
    switch (key) {
      case "-h":
      case "--help":
        usage();
        process.exit(EXIT_OK);
        break;
      case "--pack-timeout":
        opts.packTimeoutSec = Number(value);
        break;
      case "--install-timeout":
        opts.installTimeoutSec = Number(value);
        break;
      case "--start-timeout":
        opts.startTimeoutSec = Number(value);
        break;
      case "--keep-tmp":
        opts.keepTmp = true;
        break;
      default:
        fail(`Unknown argument: ${arg}
Run with --help.`);
    }
  }
  const budgets = {
    "--pack-timeout": opts.packTimeoutSec,
    "--install-timeout": opts.installTimeoutSec,
    "--start-timeout": opts.startTimeoutSec,
  };
  for (const [flag, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value <= 0) {
      fail(`${flag} must be a positive number`);
    }
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`\n[smoke-tarball] ${message}\n`);
  process.exit(EXIT_USAGE);
}

// ------------------------------------------------------------- process glue

/** Quote one cmd.exe argument if it has anything beyond plain path chars. */
function winQuote(arg) {
  return /^[\w.:\\/=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Run a command to completion with a hard wall clock. Never inherits stdio. */
function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    const spawnOpts = {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    };
    // On Windows npm is npm.cmd, which Node only spawns through a shell — and
    // a shell needs one pre-quoted command line, not an argv array.
    const child =
      process.platform === "win32" && cmd === "npm"
        ? spawn([cmd, ...args].map(winQuote).join(" "), {
            ...spawnOpts,
            shell: true,
          })
        : spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/** Last non-empty lines of a blob — enough to explain a failure, not a dump. */
function tail(text, n = 8) {
  return text
    .split("\n")
    .map((l) => l.replace(/\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

// ---------------------------------------------------------------- reporting

const say = (line) => process.stdout.write(`${line}\n`);

/** process.env minus every TM1_* variable and DOTENV_CONFIG_PATH. */
function bareProcessEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("TM1_")) env[k] = v;
  }
  delete env.DOTENV_CONFIG_PATH;
  return env;
}

// ---------------------------------------------------------------- checks

/** npm pack + npm install into a throwaway project. Throws PackError. */
class PackError extends Error {}
class Tier1Error extends Error {}

async function packAndInstall(work, opts) {
  say(`## pack`);
  // `npm pack` triggers prepack (`rm -rf dist && npm run build`), so this is
  // the real compile of the real source — and it does wipe the developer's
  // working dist/. That is the point: no stale artefact can slip through.
  const packed = await run(
    "npm",
    ["pack", "--pack-destination", work, "--loglevel=error"],
    { cwd: ROOT, timeoutMs: opts.packTimeoutSec * 1000 },
  );
  if (packed.timedOut) {
    throw new PackError(`npm pack timed out after ${opts.packTimeoutSec}s`);
  }
  if (packed.code !== 0) {
    for (const l of tail(packed.stderr)) say(`   | ${l}`);
    throw new PackError(`npm pack exited ${packed.code}`);
  }
  const tarballName = packed.stdout.trim().split("\n").filter(Boolean).pop();
  const tarball = tarballName ? join(work, tarballName) : "";
  if (!tarball || !existsSync(tarball)) {
    throw new PackError(
      `npm pack produced no tarball (stdout: ${tarballName})`,
    );
  }
  const sizeKb = Math.round(lstatSync(tarball).size / 1024);
  say(`   ${tarballName} (${sizeKb} KB)`);

  // What actually shipped — read out of the real tarball, not from a second
  // `--dry-run` (which would re-run prepack and could describe a different
  // build). A `files` regression that pulls in .env or .mcp.json leaks
  // credentials to the registry, so this is checked before anything is run.
  // Relative name + cwd: GNU tar (e.g. Git for Windows) reads "C:\..." as a
  // remote host.
  const listed = await run("tar", ["-tzf", tarballName], {
    cwd: work,
    timeoutMs: 60_000,
  });
  if (listed.code !== 0) {
    throw new PackError(
      `could not list the tarball: ${tail(listed.stderr, 1)}`,
    );
  }
  const entries = listed.stdout.split("\n").filter((l) => l.trim().length > 0);
  const offenders = entries.filter((p) =>
    FORBIDDEN_IN_TARBALL.some((re) => re.test(p)),
  );
  if (offenders.length > 0) {
    for (const o of offenders.slice(0, 10)) say(`   ! ${o}`);
    throw new PackError(
      `${offenders.length} forbidden path(s) in the tarball — check "files" in package.json`,
    );
  }
  // The shrinkwrap is what pins the consumer's dependency tree: a plain
  // package-lock.json is never published, and `overrides` don't apply to
  // dependents. Without it, lockfile security fixes never reach users.
  if (!entries.includes("package/npm-shrinkwrap.json")) {
    throw new PackError(
      "npm-shrinkwrap.json missing from the tarball — consumers would resolve dependencies unpinned",
    );
  }
  say(
    `   ${entries.length} entries, shrinkwrap present, no source/tests/maps/typings/secrets`,
  );
  say("");

  say(`## install`);
  // Fresh project, no lockfile, no dev deps — as close to what a user gets as
  // a sandboxed install can be.
  const proj = join(work, "consumer");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "package.json"),
    `${JSON.stringify(
      { name: "tm1-smoke-consumer", version: "0.0.0", private: true },
      null,
      2,
    )}\n`,
  );
  const install = await run(
    "npm",
    [
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--loglevel=error",
    ],
    { cwd: proj, timeoutMs: opts.installTimeoutSec * 1000 },
  );
  if (install.timedOut) {
    throw new PackError(
      `npm install timed out after ${opts.installTimeoutSec}s`,
    );
  }
  if (install.code !== 0) {
    for (const l of tail(install.stderr)) say(`   | ${l}`);
    throw new PackError(`npm install exited ${install.code}`);
  }
  say(`   installed into ${proj}`);
  return { proj, tarball };
}

/**
 * Where node_modules/.bin/<name> points. POSIX npm makes a symlink; Windows npm
 * writes a sh shim (plus .cmd/.ps1) that execs "$basedir/<relative target>".
 */
function resolveBinShim(binLink) {
  if (process.platform !== "win32") return realpathSync(binLink);
  const shim = readFileSync(binLink, "utf8");
  const m = /"\$basedir\/([^"]+\.js)"/.exec(shim);
  if (!m) throw new Tier1Error(`unrecognised npm bin shim at ${binLink}`);
  return realpathSync(resolve(dirname(binLink), m[1]));
}

/** Everything that must hold for the INSTALLED package. Throws Tier1Error. */
async function tier1(proj, opts) {
  say(`## installed artefact`);

  // 1. The bin entry. npm creates node_modules/.bin/<name> from the "bin"
  //    field; a typo there means `npx tm1-mcp-server` is simply not a command,
  //    and no source test can see it.
  const binLink = join(proj, "node_modules", ".bin", "tm1-mcp-server");
  if (!existsSync(binLink)) {
    throw new Tier1Error(`no bin shim at node_modules/.bin/tm1-mcp-server`);
  }
  const binTarget = resolveBinShim(binLink);
  const expectedDir =
    join(proj, "node_modules", ...PKG.name.split("/"), "dist") + sep;
  if (!realpathSync(binTarget).startsWith(realpathSync(expectedDir))) {
    throw new Tier1Error(
      `bin shim resolves outside the installed package: ${binTarget}`,
    );
  }
  if (!binTarget.endsWith(`${sep}dist${sep}index.js`)) {
    throw new Tier1Error(
      `bin shim does not point at dist/index.js: ${binTarget}`,
    );
  }
  say(`   bin → ${binTarget.slice(proj.length + 1)}`);

  // 2. The shebang. Without it the shim is executed by the shell, not node,
  //    and the user gets a syntax-error salad from /bin/sh.
  const fd = openSync(binTarget, "r");
  const head = Buffer.alloc(64);
  const n = readSync(fd, head, 0, 64, 0);
  closeSync(fd);
  const firstLine = head.subarray(0, n).toString("utf8").split("\n")[0];
  if (firstLine !== "#!/usr/bin/env node") {
    throw new Tier1Error(
      `dist/index.js first line is ${JSON.stringify(firstLine)}, expected "#!/usr/bin/env node"`,
    );
  }
  say(`   shebang ok`);

  // 3. Version identity: the compiled entrypoint reads package.json at runtime
  //    (src/version.ts). If the tarball ever shipped without it, VERSION
  //    silently degrades to "unknown" and every MCP client sees a lie.
  const installedPkgPath = join(
    proj,
    "node_modules",
    ...PKG.name.split("/"),
    "package.json",
  );
  const installedPkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
  if (installedPkg.version !== PKG.version) {
    throw new Tier1Error(
      `installed version ${installedPkg.version} != repo version ${PKG.version}`,
    );
  }
  say(`   version ${installedPkg.version}`);

  // 4. Start with NO configuration at all. The contract is a readable
  //    configuration error and a prompt non-zero exit — not a hang (which
  //    leaves an MCP client spinning forever) and not a bare stack.
  // bareProcessEnv() strips every TM1_* variable (and DOTENV_CONFIG_PATH) from the
  // caller's shell. The child's cwd and package root are both under tmpdir(),
  // so load-env.ts finds no .env either. HOME/USERPROFILE point at the empty
  // project dir too: without TM1_BASE_URL the server looks for connection
  // folders under ~/.tm1/mcp-servers, and the developer's real ones must not
  // turn this into a configured start.
  const bareEnv = { ...bareProcessEnv(), HOME: proj, USERPROFILE: proj };
  const started = Date.now();
  const noConfig = await run(process.execPath, [binTarget], {
    cwd: proj,
    env: bareEnv,
    timeoutMs: opts.startTimeoutSec * 1000,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (noConfig.timedOut) {
    throw new Tier1Error(
      `unconfigured start HUNG — still alive after ${opts.startTimeoutSec}s ` +
        `(an MCP client would wait forever)`,
    );
  }
  if (noConfig.code === 0) {
    throw new Tier1Error(
      `unconfigured start exited 0 — a server with no TM1 target must fail`,
    );
  }
  const errText = noConfig.stderr;
  // Both ways to configure it must be named: one TM1_BASE_URL, or a folder
  // of connections.
  const wanted = ["TM1_BASE_URL", "TM1_CONNECTIONS_DIR"];
  const missingFromMessage = wanted.filter((w) => !errText.includes(w));
  if (
    !/No TM1 connections found/i.test(errText) ||
    missingFromMessage.length > 0
  ) {
    for (const l of tail(errText)) say(`   | ${l}`);
    throw new Tier1Error(
      `unconfigured start did not name the missing configuration ` +
        `(absent from stderr: ${missingFromMessage.join(", ") || "message text"})`,
    );
  }
  // The diagnosis must be the FIRST thing on stderr. A stack trace above it
  // means the user has to read a crash dump to learn they forgot a variable.
  const firstErrLine = tail(errText, 200)[0] ?? "";
  if (!firstErrLine.includes("No TM1 connections found")) {
    say(`   | ${firstErrLine}`);
    throw new Tier1Error(
      `stderr opens with something other than the configuration error`,
    );
  }
  if (noConfig.stdout.trim().length > 0) {
    for (const l of tail(noConfig.stdout, 3)) say(`   | stdout: ${l}`);
    throw new Tier1Error(
      `wrote to stdout while failing — that corrupts the JSON-RPC stream`,
    );
  }
  say(`   unconfigured start → exit ${noConfig.code} in ${secs}s, clear error`);
  say(`   => PASS`);
}

// --------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  say(`# tm1-mcp-server tarball smoke — ${new Date().toISOString()}`);
  say(`# package ${PKG.name}@${PKG.version}`);
  say("");

  // Throwaway root under os.tmpdir(), NEVER inside the repo: a stray
  // node_modules plus a tarball in the working tree is how something
  // eventually gets committed by accident.
  const work = mkdtempSync(join(tmpdir(), "tm1-mcp-smoke-"));
  try {
    let proj;
    try {
      ({ proj } = await packAndInstall(work, opts));
    } catch (err) {
      if (!(err instanceof PackError)) throw err;
      say(`   => PACK/INSTALL FAILED — ${err.message}`);
      say("");
      say("## summary");
      say(`   PACK/INSTALL FAILED — nothing was verified`);
      return EXIT_PACK;
    }
    say("");

    try {
      await tier1(proj, opts);
    } catch (err) {
      if (!(err instanceof Tier1Error)) throw err;
      say(`   => FAIL — ${err.message}`);
      say("");
      say("## summary");
      say(`   FAILED — the installed artefact is broken`);
      return EXIT_TIER1;
    }

    say("");
    say("## summary");
    say(`   PASS`);
    return EXIT_OK;
  } finally {
    // Cleanup on success AND on failure. The whole install lives in one
    // mkdtemp root, so a single rm is the entire teardown.
    if (opts.keepTmp) {
      say(`
(kept ${work} — --keep-tmp)`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `
[smoke-tarball] unexpected error: ${String(err.stack ?? err)}
`,
    );
    process.exit(EXIT_USAGE);
  });
