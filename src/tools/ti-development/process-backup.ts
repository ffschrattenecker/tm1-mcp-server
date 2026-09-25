import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { serializeProcessToGit } from "../../lib/git-process.js";
import type { TM1Client } from "../../tm1-client.js";

// Automatic backup of an installed process before a tool overwrites it.
//
// Replacing a process is not undoable through the REST API, and until this
// existed the rollback copy depended on the caller remembering to export
// first. The backup is the tm1-git pair tm1_export_process_to_git produces,
// so tm1_import_process_from_git is the restore path.
//
// The directory is chosen by the server, never by the caller, so it is not
// confined to TM1_LOCAL_FILE_ROOT and is on by default:
//   TM1_PROCESS_BACKUP_DIR unset → ~/.tm1-mcp-server/backups
//   TM1_PROCESS_BACKUP_DIR=off   → no backup
// Under it: <connection>/<process>/<timestamp>.json + .ti.
//
// The code is written UNMASKED. A masked backup restores a process that
// carries placeholder literals, looks deployed, and fails at runtime. The ODBC
// datasource password is never written (serializeProcessToGit strips it).

const DIR_ENV = "TM1_PROCESS_BACKUP_DIR";

export interface ProcessBackup {
  json: string;
  ti: string;
}

export interface GitPair {
  json: string;
  ti: string;
  credentialsOmitted: boolean;
  parameterCount: number;
  variableCount: number;
  dataSourceType: string;
  hasSecurityAccess: boolean;
}

/** Read an installed process as the tm1-git pair. Code is returned as stored. */
export async function readProcessAsGit(
  tm1Client: TM1Client,
  processName: string,
  opts?: { includePassword?: boolean },
): Promise<GitPair> {
  const includePassword = opts?.includePassword === true;
  const [ti, parameters, layout, dataSource, deployMeta] = await Promise.all([
    tm1Client.processes.getCodeBlob(processName),
    tm1Client.processes.getParameters(processName),
    tm1Client.processes.getVariableLayout(processName),
    tm1Client.processes.getDataSource(processName, {
      includeSecrets: includePassword,
    }),
    tm1Client.processes.getDeployMeta(processName),
  ]);
  const { json, credentialsOmitted } = serializeProcessToGit(
    {
      name: processName,
      parameters,
      variables: layout.variables,
      ...(layout.variablesUIData !== undefined
        ? { variablesUIData: layout.variablesUIData }
        : {}),
      dataSource,
      hasSecurityAccess: deployMeta.hasSecurityAccess,
    },
    { includePassword },
  );
  return {
    json,
    ti,
    credentialsOmitted,
    parameterCount: parameters.length,
    variableCount: layout.variables.length,
    dataSourceType: dataSource.type,
    hasSecurityAccess: deployMeta.hasSecurityAccess,
  };
}

/** The backup root, or null when backups are switched off. */
export function backupRoot(): string | null {
  const raw = process.env[DIR_ENV]?.trim();
  if (raw?.toLowerCase() === "off") return null;
  return raw
    ? path.resolve(raw)
    : path.join(os.homedir(), ".tm1-mcp-server", "backups");
}

// Windows rejects < > : " / \ | ? * and control characters, and trailing dots
// or spaces. The real name is inside the .json, so the mapping need not be
// reversible.
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

function timestamp(now: Date): string {
  // 2026-09-25T14:03:07.123Z → 20260925T140307123Z
  return now.toISOString().replace(/[-:.]/g, "");
}

/**
 * Write the installed state of `processName` to the backup directory and
 * return the two paths, or null when backups are off. Throws a TM1Error when
 * the backup cannot be written: callers run this before their first write, so
 * a failed backup means nothing is overwritten.
 */
export async function backupProcess(
  tm1Client: TM1Client,
  processName: string,
  now: Date = new Date(),
): Promise<ProcessBackup | null> {
  const root = backupRoot();
  if (root === null) return null;
  try {
    const pair = await readProcessAsGit(tm1Client, processName);
    const dir = path.join(
      root,
      safeFileName(tm1Client.connectionId),
      safeFileName(processName),
    );
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, timestamp(now));
    const backup = { json: `${base}.json`, ti: `${base}.ti` };
    // wx: never replace an earlier backup, even on a same-millisecond retry.
    await fs.writeFile(backup.json, pair.json, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.writeFile(backup.ti, pair.ti, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return backup;
  } catch (err) {
    const reason =
      err instanceof TM1Error
        ? `${err.code}: ${err.message}`
        : (err as Error).message;
    throw new TM1Error({
      code: err instanceof TM1Error ? err.code : TM1ErrorCode.VALIDATION_ERROR,
      message: `Backup of process '${processName}' failed before overwriting it: ${reason}. Nothing was written.`,
      hint: `Fix the cause (${DIR_ENV} must name a writable directory), or set ${DIR_ENV}=off to overwrite without a backup.`,
    });
  }
}
