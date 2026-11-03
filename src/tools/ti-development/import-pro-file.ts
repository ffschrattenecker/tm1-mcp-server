import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { IDEMPOTENT_DESTRUCTIVE } from "../annotations.js";
import { ImportProFileResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import {
  OVERWRITE_CONFIRM_SCHEMA,
  requireOverwriteConfirm,
} from "../confirm.js";
import {
  deployModeError,
  installHints,
  runPreflight,
  writeInstall,
} from "./preflight.js";
import { backupProcess } from "./process-backup.js";
import { loadProSource, PRO_SOURCE_SCHEMA } from "./pro-source.js";
import { jsonError, jsonResult } from "../format.js";

export const registerImportProFile = defineTool({
  name: "tm1_import_pro_file",
  description:
    "Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call. Provide either filePath (absolute path on the MCP host) or content (the .pro file body as string). Modes: 'create' (fail if exists), 'update' (fail if missing), 'upsert' (default — create or update). Only a .pro exported by tm1_export_process_to_pro from v12 carries the ODBC password (in clear); pass dataSourcePassword for any other ODBC process.",
  annotations: IDEMPOTENT_DESTRUCTIVE,
  output: ImportProFileResultSchema,
  input: {
    ...PRO_SOURCE_SCHEMA,
    processName: z
      .string()
      .optional()
      .describe(
        "Override process name. Default: name parsed from .pro (602,'Name').",
      ),
    mode: z
      .enum(["create", "update", "upsert"])
      .optional()
      .default("upsert")
      .describe("Deployment mode (default: upsert)"),
    preflight: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Run the syntax check (tm1_check_process_code) AND the reference check (tm1_validate_process_refs) on the exact payload before applying; abort on either. Default true. false skips both.",
      ),
    ...OVERWRITE_CONFIRM_SCHEMA,
    dataSourcePassword: z
      .string()
      .optional()
      .describe(
        "ODBC password to inject, in clear text; the target server encrypts it. Overrides whatever the file carries. This is the normal way to deploy an ODBC process: a .pro from TM1's own Datadir has its slot 565 ignored (that encoding cannot be replayed over REST), and a v11 export never carries a password. Ignored for non-ODBC datasources.",
      ),
  },
  handler: async (
    {
      filePath,
      content,
      processName: nameOverride,
      mode,
      preflight,
      dataSourcePassword,
      confirm,
    },
    tm1Client,
  ) => {
    const parsed = await loadProSource({ filePath, content });
    if (parsed.dataSource.type === "ODBC" && dataSourcePassword !== undefined)
      parsed.dataSource.password = dataSourcePassword;
    const processName = nameOverride ?? parsed.name;
    if (!processName) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Process name not found in .pro (602,'Name') and no name override provided",
      });
    }

    if (preflight) {
      const failure = await runPreflight(tm1Client, {
        ...parsed,
        name: processName,
      });
      if (failure) return jsonError(failure);
    }

    const allProcs = await tm1Client.processes.list({ namesOnly: true });
    const exists = allProcs.some(
      (p: { name: string }) => p.name === processName,
    );
    const modeError = deployModeError(mode, exists, processName);
    if (modeError) throw modeError;

    // Replacing an installed process is not undoable through the API.
    if (exists) requireOverwriteConfirm(confirm, processName, "process");
    // Last step before the first write: a failed backup throws, nothing is written.
    const backup = exists ? await backupProcess(tm1Client, processName) : null;

    await writeInstall(tm1Client.processes, processName, parsed, {
      exists,
      hints: installHints(processName, exists, parsed.dataSource.type),
    });

    return jsonResult({
      action: exists ? "updated" : "created",
      processName,
      ...(backup ? { backup } : {}),
      parsed: {
        prologLines: parsed.prolog.split("\n").length,
        metadataLines: parsed.metadata.split("\n").length,
        dataLines: parsed.data.split("\n").length,
        epilogLines: parsed.epilog.split("\n").length,
        parameterCount: parsed.parameters.length,
        variableCount: parsed.variables.length,
        dataSourceType: parsed.dataSource.type,
      },
    });
  },
});
