// Live check for the automatic backup the overwrite tools write before they
// replace an installed process. The claim under test is not "a file appears"
// but "the file is a rollback": restoring it with tm1_import_process_from_git
// must bring back exactly the export taken before the overwrite.
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getHarness,
  LIVE_ENABLED,
  SANDBOX,
  type LiveHarness,
} from "./harness.js";

const WITH_PARAM = `${SANDBOX}_BACKUP_PARAM`;
const BARE = `${SANDBOX}_BACKUP_BARE`;

describe.skipIf(!LIVE_ENABLED)("live: process backup before overwrite", () => {
  let h: LiveHarness;

  const cleanup = async () => {
    for (const name of [WITH_PARAM, BARE]) {
      try {
        await h.call("tm1_delete_process", {
          processName: name,
          confirm: name,
        });
      } catch {
        /* already gone */
      }
    }
  };

  const snapshot = async (processName: string) => {
    const r = await h.ok("tm1_export_process_to_git", {
      processName,
      maskSecrets: false,
    });
    // The import sends the .ti as CRLF, the form TM1 itself writes; a process
    // created over REST with LF code comes back with CRLF after a restore.
    // Not a difference TI sees, so it is normalized out of the comparison.
    return {
      json: r.json.json as string,
      ti: (r.json.ti as string).replace(/\r\n/g, "\n"),
    };
  };

  const overwriteThenRestore = async (processName: string) => {
    const before = await snapshot(processName);
    const r = await h.ok("tm1_upsert_process", {
      processName,
      prolog: "nChanged = 2;",
      epilog: "nAdded = 3;",
      parameters: [{ name: "pNew", type: "Numeric", defaultValue: 7 }],
      dataSource: {
        type: "ASCII",
        dataSourceNameForServer: "backup-live-test.csv",
        asciiDelimiterType: "Character",
        asciiDelimiterChar: ",",
      },
      confirm: processName,
    });
    const backup = r.json.backup as { json: string; ti: string };
    expect(backup.json.startsWith(process.env.TM1_PROCESS_BACKUP_DIR!)).toBe(
      true,
    );
    expect(await snapshot(processName)).not.toEqual(before);

    await h.ok("tm1_import_process_from_git", {
      jsonContent: readFileSync(backup.json, "utf8"),
      tiContent: readFileSync(backup.ti, "utf8"),
      confirm: processName,
    });
    return { before, after: await snapshot(processName) };
  };

  beforeAll(async () => {
    process.env.TM1_PROCESS_BACKUP_DIR = mkdtempSync(
      path.join(tmpdir(), "tm1-backup-live-"),
    );
    h = await getHarness();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    process.env.TM1_PROCESS_BACKUP_DIR = "off";
  });

  it("restoring the backup undoes an overwrite (process with a parameter)", async () => {
    await h.ok("tm1_upsert_process", {
      processName: WITH_PARAM,
      prolog: "nOriginal = 1;",
      parameters: [{ name: "pOld", type: "Numeric", defaultValue: 1 }],
    });
    const { before, after } = await overwriteThenRestore(WITH_PARAM);
    expect(after).toEqual(before);
  });

  it("restoring the backup undoes an overwrite (process without parameters)", async () => {
    await h.ok("tm1_upsert_process", {
      processName: BARE,
      prolog: "nOriginal = 1;",
    });
    const { before, after } = await overwriteThenRestore(BARE);
    expect(after).toEqual(before);
  });
});
