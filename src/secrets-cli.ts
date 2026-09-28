// `tm1-mcp-server secrets <command>` — manage the keychain entries of a
// connection (see ./secrets.ts). No command ever prints a secret value.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { connectionsDir } from "./connections.js";
import {
  isSecretKey,
  keychainAccount,
  keychainStore,
  plaintextSecretKeys,
  SECRET_KEYS,
  type SecretKey,
  type SecretStore,
} from "./secrets.js";

const USAGE = `Usage: tm1-mcp-server secrets <command> <connection> [KEY]

  set <connection> [KEY]     store a secret (prompted, or read from stdin)
  list <connection>          show which secrets are stored (never the values)
  delete <connection> [KEY]  remove one secret, or all of the connection's
  migrate <connection>       move the plaintext secrets of <connection>/.env
                             into the keychain and set TM1_SECRETS=keychain

KEY is one of ${SECRET_KEYS.join(", ")} (default TM1_PASSWORD).
<connection> is a folder under ~/.tm1/mcp-servers (or $TM1_CONNECTIONS_DIR).`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads one secret without echoing it. */
  readSecret: (prompt: string) => Promise<string>;
}

export async function runSecretsCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo = processIo,
  store?: SecretStore,
): Promise<number> {
  const [command, connection, keyArg, ...extra] = args;
  if (!command || command === "help" || command === "--help") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  if (!connection || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  if (keyArg !== undefined && !isSecretKey(keyArg)) {
    io.err(`Unknown KEY "${keyArg}". One of: ${SECRET_KEYS.join(", ")}.`);
    return 2;
  }
  const folder = join(connectionsDir(env), connection);
  const envFile = join(folder, ".env");
  if (!existsSync(envFile)) {
    io.err(`No connection "${connection}": ${envFile} does not exist.`);
    return 2;
  }

  let keychain: SecretStore;
  try {
    keychain = store ?? (await keychainStore());
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  switch (command) {
    case "set": {
      const key = keyArg ?? "TM1_PASSWORD";
      const value = await io.readSecret(`${key} for ${connection}: `);
      if (value === "") {
        io.err("Empty value — nothing stored.");
        return 1;
      }
      // Pasted or piped junk becomes a wrong password, and wrong passwords
      // lock TM1 accounts.
      if (/[\r\n]/.test(value)) {
        io.err("The value spans several lines — nothing stored.");
        return 1;
      }
      keychain.set(connection, key, value);
      io.out(`Stored ${keychainAccount(connection, key)}.`);
      const marker = parseDotenv(readFileSync(envFile)).TM1_SECRETS;
      if (marker?.trim().toLowerCase() !== "keychain") {
        io.out(
          `The .env does not set TM1_SECRETS=keychain yet, so the server ` +
            `ignores this entry. Run \`secrets migrate ${connection}\` or add it.`,
        );
      }
      return 0;
    }
    case "list": {
      for (const key of SECRET_KEYS) {
        const stored = keychain.get(connection, key) !== undefined;
        io.out(`${key.padEnd(18)} ${stored ? "stored" : "-"}`);
      }
      return 0;
    }
    case "delete": {
      const keys: readonly SecretKey[] = keyArg ? [keyArg] : SECRET_KEYS;
      for (const key of keys) {
        if (keychain.delete(connection, key)) {
          io.out(`Deleted ${keychainAccount(connection, key)}.`);
        } else if (keyArg) {
          io.out(`No entry ${keychainAccount(connection, key)}.`);
        }
      }
      return 0;
    }
    case "migrate":
      return migrate(connection, envFile, keychain, io);
    default:
      io.err(`Unknown command "${command}".\n${USAGE}`);
      return 2;
  }
}

/**
 * Move the plaintext secrets of one `.env` into the keychain. Order matters:
 * every secret is stored and read back BEFORE the file changes, and the new
 * file is checked to parse to exactly the old settings minus the secrets. No
 * plaintext backup is kept — that would defeat the point.
 */
function migrate(
  connection: string,
  envFile: string,
  keychain: SecretStore,
  io: CliIo,
): number {
  const text = readFileSync(envFile, "utf8");
  const before = parseDotenv(text);
  const keys = plaintextSecretKeys(before);
  if (keys.length === 0) {
    io.out(`${envFile} holds no plaintext secret.`);
    return 0;
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
      line,
    );
    const name = match?.[1];
    if (name && ((keys as string[]).includes(name) || name === "TM1_SECRETS")) {
      const value = match[2]!.trim();
      const quote = value[0];
      if (
        (quote === '"' || quote === "'" || quote === "`") &&
        value.indexOf(quote, 1) === -1
      ) {
        io.err(`${name} in ${envFile} is a multi-line value; move it by hand.`);
        return 1;
      }
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  kept.push("TM1_SECRETS=keychain", "");
  const next = kept.join(eol);

  const after = parseDotenv(next);
  // A blank value (TM1_PASSWORD= for a blank-password account) is no secret
  // and stays in the file.
  const expected: Record<string, string> = {
    ...before,
    TM1_SECRETS: "keychain",
  };
  for (const key of keys) delete expected[key];
  if (JSON.stringify(sorted(after)) !== JSON.stringify(sorted(expected))) {
    io.err(`Could not rewrite ${envFile} safely; nothing changed.`);
    return 1;
  }

  for (const key of keys) {
    const value = before[key]!;
    keychain.set(connection, key, value);
    if (keychain.get(connection, key) !== value) {
      io.err(
        `Reading ${keychainAccount(connection, key)} back returned a different ` +
          `value; ${envFile} left unchanged.`,
      );
      return 1;
    }
    io.out(`Stored ${keychainAccount(connection, key)}.`);
  }

  const tmp = `${envFile}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, envFile);
  io.out(
    `Removed ${keys.join(", ")} from ${envFile} and set TM1_SECRETS=keychain. ` +
      `Restart the MCP client to pick up the change.`,
  );
  return 0;
}

function sorted(obj: Record<string, string>): [string, string][] {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readSecret: (prompt) =>
    process.stdin.isTTY ? promptHidden(prompt) : readPipedStdin(),
};

/**
 * `echo secret | tm1-mcp-server secrets set …` — a leading BOM (PowerShell
 * pipes) and one trailing newline dropped. Git Bash's mintty is no TTY to
 * Node either, so typed input lands here too, echoed: say so.
 */
async function readPipedStdin(): Promise<string> {
  process.stderr.write(
    "Reading the secret from stdin until EOF. In a terminal that is no TTY to " +
      "Node (Git Bash/mintty) the input is echoed; pipe the value or use " +
      "PowerShell/cmd instead.\n",
  );
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return stripPipedInput(Buffer.concat(chunks).toString("utf8"));
}

export function stripPipedInput(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Aborted."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
