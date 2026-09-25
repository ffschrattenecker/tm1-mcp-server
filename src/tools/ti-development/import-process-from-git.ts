import { promises as fs } from "node:fs";
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";
import {
  parseProcessFromGit,
  unplacedBlobContent,
} from "../../lib/git-process.js";
import { withToolHint } from "../error-format.js";
import { IDEMPOTENT_DESTRUCTIVE } from "../annotations.js";
import { ImportProcessFromGitResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import {
  OVERWRITE_CONFIRM_SCHEMA,
  requireOverwriteConfirm,
} from "../confirm.js";
import { preflightResult, runPreflight } from "./preflight.js";
import { backupProcess } from "./process-backup.js";

export const registerImportProcessFromGit = defineTool({
  name: "tm1_import_process_from_git",
  description: [
    "Deploy a TM1 process from the tm1-git two-file layout ('{name}.json' + '{name}.ti'). Provide the pair inline (jsonContent + tiContent) or as host paths (jsonPath + tiPath).",
    "Reverse of tm1_export_process_to_git. Modes: 'create' (fail if exists), 'update' (fail if missing), 'upsert' (default).",
    "If the source datasource is ODBC, pass dataSourcePassword to re-inject the credential that export strips.",
  ],
  annotations: IDEMPOTENT_DESTRUCTIVE,
  output: ImportProcessFromGitResultSchema,
  input: {
    jsonContent: z
      .string()
      .optional()
      .describe("Raw '{name}.json' body as string (structure)."),
    tiContent: z
      .string()
      .optional()
      .describe("Raw '{name}.ti' body as string (procedure tabs)."),
    jsonPath: z
      .string()
      .optional()
      .describe(
        "Absolute host path to the .json file. Disabled unless TM1_LOCAL_FILE_ROOT is set; must resolve within that directory.",
      ),
    tiPath: z
      .string()
      .optional()
      .describe(
        "Absolute host path to the .ti file. Disabled unless TM1_LOCAL_FILE_ROOT is set; must resolve within that directory.",
      ),
    processName: z
      .string()
      .optional()
      .describe("Override process name. Default: name from the JSON."),
    mode: z
      .enum(["create", "update", "upsert"])
      .optional()
      .default("upsert")
      .describe("Deployment mode (default: upsert)"),
    dataSourcePassword: z
      .string()
      .optional()
      .describe(
        "ODBC password to re-inject, in clear text; the target server encrypts it. Overrides whatever the .json carries. Export omits the password unless includeDataSourcePassword was set, which is possible on v12 only — so on v11 this is the only way to deploy a working ODBC process. Ignored for non-ODBC datasources.",
      ),
    ...OVERWRITE_CONFIRM_SCHEMA,
    preflight: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Run the syntax check (tm1_check_process_code) AND the reference check (tm1_validate_process_refs) on the exact payload before applying; abort on either. Default true. false skips both.",
      ),
  },
  handler: async (
    {
      jsonContent,
      tiContent,
      jsonPath,
      tiPath,
      processName: nameOverride,
      mode,
      dataSourcePassword,
      preflight,
      confirm,
    },
    tm1Client,
  ) => {
    let json = jsonContent ?? "";
    let ti = tiContent ?? "";
    if (!json && jsonPath)
      json = await fs.readFile(resolveLocalPath(jsonPath, "jsonPath"), "utf8");
    if (!ti && tiPath)
      ti = await fs.readFile(resolveLocalPath(tiPath, "tiPath"), "utf8");

    if (!json || !ti) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Provide both the JSON and TI parts (jsonContent+tiContent or jsonPath+tiPath)",
      });
    }

    let parsed;
    try {
      parsed = parseProcessFromGit(json, ti);
    } catch (err) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: (err as Error).message,
      });
    }

    const processName = nameOverride ?? parsed.name;
    if (!processName) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Process name not found in JSON ('name') and no name override provided",
      });
    }

    const dataSource = { ...parsed.dataSource };
    if (dataSource.type === "ODBC" && dataSourcePassword !== undefined) {
      dataSource.password = dataSourcePassword;
    }

    if (preflight) {
      // The raw .ti blob is what deploys (TM1 splits it into tabs), so the
      // parsed tabs are only an exact stand-in for it when every byte of the
      // blob sits inside exactly one tab region. Anything else would be
      // installed without having been checked.
      const unplaced = unplacedBlobContent(ti);
      if (unplaced.length > 0) {
        return preflightResult({
          stage: "preflight",
          check: "syntax",
          processName,
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `The .ti blob carries content the preflight cannot place in a tab: ${unplaced.join("; ")}.`,
          hint: "Nothing was installed. Keep all code inside one #region Prolog/Metadata/Data/Epilog … #endregion block per tab — re-export with tm1_export_process_to_git if unsure.",
        });
      }
      const failure = await runPreflight(tm1Client, {
        name: processName,
        prolog: parsed.prolog,
        metadata: parsed.metadata,
        data: parsed.data,
        epilog: parsed.epilog,
        parameters: parsed.parameters,
        variables: parsed.variables,
        dataSource,
      });
      if (failure) return preflightResult(failure);
    }

    const exists = await tm1Client.processes.exists(processName);

    if (mode === "create" && exists) {
      throw new TM1Error({
        code: TM1ErrorCode.CONFLICT,
        message: `Process '${processName}' already exists; mode=create`,
      });
    }
    if (mode === "update" && !exists) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `Process '${processName}' does not exist; mode=update`,
      });
    }

    // Replacing an installed process is not undoable through the API.
    if (exists) requireOverwriteConfirm(confirm, processName, "process");
    // Last step before the first write: a failed backup throws, nothing is written.
    const backup = exists ? await backupProcess(tm1Client, processName) : null;

    const action = exists ? "updated" : "created";
    if (!exists) {
      await withToolHint(
        tm1Client.processes.create(processName),
        `Process create failed mid-import. Name '${processName}' may already exist (race) or contain invalid characters. tm1_list_processes to verify state before retry.`,
      );
    }

    // Write code via TM1's native Code property: send the raw #region blob
    // (normalized to CRLF, as TM1 emits/expects) and let the server split it
    // into the four tabs. This is a full replace — tabs whose region is
    // absent are cleared, matching the exported .ti exactly.
    // The parsed tabs were preflighted above; unplacedBlobContent() made
    // sure they cover this blob exactly, so what was checked is what deploys.
    await withToolHint(
      tm1Client.processes.updateCodeBlob(
        processName,
        ti.replace(/\r?\n/g, "\r\n"),
      ),
      `Code update failed after process '${processName}' was ${exists ? "located" : "created"}. PARTIAL APPLY: shell exists but tabs are stale/empty. Re-run with mode=update once root cause fixed, or tm1_delete_process to roll back.`,
    );

    // On an update the file replaces the whole definition, as the code tabs
    // already do: an empty parameter list, variable layout or a None
    // datasource is applied, not skipped. Skipping left the newer values in
    // place, so importing an older version (a backup) did not restore it.
    if (exists || parsed.parameters.length > 0) {
      await withToolHint(
        tm1Client.processes.updateParameters(processName, parsed.parameters),
        `Parameter update failed for '${processName}'. Code applied but parameters missing. tm1_upsert_process with mode=update + parameters=[...] to recover.`,
      );
    }
    // Ignored columns live only in the UI data, so a .json can carry column
    // layout with an empty variable list — patch on either.
    if (
      exists ||
      parsed.variables.length > 0 ||
      (parsed.variablesUIData?.length ?? 0) > 0
    ) {
      await withToolHint(
        tm1Client.processes.updateVariables(
          processName,
          parsed.variables,
          parsed.variablesUIData ??
            (parsed.variables.length === 0 ? [] : undefined),
        ),
        `Variable update failed for '${processName}'. Code+parameters applied but variables missing. tm1_upsert_process with mode=update + variables=[...] to recover.`,
      );
    }
    if (exists || dataSource.type !== "None") {
      await withToolHint(
        tm1Client.processes.updateDataSource(processName, dataSource),
        `Datasource update failed for '${processName}' (type=${dataSource.type}). Code+params+vars applied. For ODBC verify dataSourcePassword/DSN and re-run with mode=update.`,
      );
    }

    if (parsed.hasSecurityAccess !== undefined) {
      await withToolHint(
        tm1Client.processes.updateSecurityAccess(
          processName,
          parsed.hasSecurityAccess,
        ),
        `HasSecurityAccess update failed for '${processName}'. Code+params+vars+datasource applied. Re-run with mode=update once root cause fixed.`,
      );
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              action,
              processName,
              ...(backup ? { backup } : {}),
              ...(parsed.hasSecurityAccess !== undefined
                ? { hasSecurityAccess: parsed.hasSecurityAccess }
                : {}),
              parsed: {
                prologLines: parsed.prolog.split("\n").length,
                metadataLines: parsed.metadata.split("\n").length,
                dataLines: parsed.data.split("\n").length,
                epilogLines: parsed.epilog.split("\n").length,
                parameterCount: parsed.parameters.length,
                variableCount: parsed.variables.length,
                dataSourceType: dataSource.type,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
