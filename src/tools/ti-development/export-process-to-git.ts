import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { supportsCredentialExport } from "../../lib/credential-format.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";
import { parseProcessFromGit } from "../../lib/git-process.js";
import {
  MASK_SECRETS_DESCRIPTION,
  maskCode,
  resolveMaskSecrets,
} from "../../lib/mask-secrets.js";
import { ExportProcessToGitResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { readProcessAsGit } from "./process-backup.js";
import { jsonResult } from "../format.js";

export const registerExportProcessToGit = defineTool({
  name: "tm1_export_process_to_git",
  description: [
    "Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' — the server's own REST payload for the process without the code (Name, HasSecurityAccess, UIData, VariablesUIData, DataSource, Parameters, Variables; server key order, no renamed fields) — plus a '{name}.ti' (Prolog/Metadata/Data/Epilog as plain code).",
    "The .ti holds the code in TM1's native `Code` representation (#region <Tab> / #endregion, CRLF, empty tabs omitted); the .json holds the structure.",
    "Returns both file bodies (json + ti) inline by default. With writeToDir they go to disk instead and the response carries only metadata (filenames, counts, writtenTo paths). Files written via writeToDir re-import with tm1_import_process_from_git.",
    "Security: the ODBC datasource password is stripped unless includeDataSourcePassword is set (which also requires writeToDir); credentialsOmitted=true flags when one was stripped.",
  ],
  annotations: READ_ONLY,
  output: ExportProcessToGitResultSchema,
  input: {
    processName: z.string().describe("Name of the TI process to export"),
    writeToDir: z
      .string()
      .optional()
      .describe(
        "Optional absolute host directory to write '{name}.json' and '{name}.ti' into. If omitted, content is only returned inline.",
      ),
    maskSecrets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        `${MASK_SECRETS_DESCRIPTION} Inline copy only; written files stay unmasked.`,
      ),
    includeDataSourcePassword: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Write the ODBC datasource password into the .json. v12 ONLY (v11 refuses it). Requires writeToDir. The value written is the PLAIN password: do not commit the result.",
      ),
  },
  handler: async (
    { processName, writeToDir, maskSecrets, includeDataSourcePassword },
    tm1Client,
  ) => {
    if (includeDataSourcePassword && !writeToDir) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "includeDataSourcePassword requires writeToDir — the credential must go to a file, not into the inline response.",
      });
    }
    // See src/lib/credential-format.ts: a v11 credential is scoped to one
    // server run, so an exported one rots without any visible sign.
    if (
      includeDataSourcePassword &&
      !supportsCredentialExport(tm1Client.version)
    ) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "includeDataSourcePassword is v12-only. On v11 the exported credential stops working when the TM1 service restarts, and the .json gives no sign of it. To clone a process with its password inside this instance use tm1_copy_process; to deploy elsewhere or later, export without the password and pass dataSourcePassword to tm1_import_process_from_git.",
      });
    }
    const pair = await readProcessAsGit(tm1Client, processName, {
      includePassword: includeDataSourcePassword === true,
    });
    // The file is the deployable copy and gets the code as it is: a masked
    // literal would re-import as broken code ('***' instead of the password).
    // Masking applies to what goes back to the model — the inline body.
    const ti = pair.ti;
    const inlineTi = resolveMaskSecrets(maskSecrets) ? maskCode(ti) : ti;
    const { json, credentialsOmitted } = pair;

    // The .json is the server's payload verbatim, so a field or data source
    // type the import does not know gets written without complaint. Say so
    // now rather than at the next import.
    let warning: string | undefined;
    try {
      parseProcessFromGit(json, ti);
    } catch (e) {
      warning = `tm1_import_process_from_git would refuse this export: ${(e as Error).message}`;
    }

    const jsonFileName = `${processName}.json`;
    const tiFileName = `${processName}.ti`;

    const writtenTo: { json: string | null; ti: string | null } = {
      json: null,
      ti: null,
    };
    if (writeToDir) {
      // Reject path separators in the process name so the join below cannot
      // climb out of the target directory (resolveLocalPath also confines it).
      if (/[\\/]|\.\./.test(processName)) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Process name '${processName}' contains path separators; cannot derive safe file names`,
        });
      }
      const dir = resolveLocalPath(writeToDir, "writeToDir");
      const jsonPath = resolveLocalPath(
        path.join(dir, jsonFileName),
        "writeToDir",
      );
      const tiPath = resolveLocalPath(path.join(dir, tiFileName), "writeToDir");
      // Create the target directory only AFTER confinement above, so the
      // symlink-aware realpath check ran against the pre-existing tree.
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(jsonPath, json, "utf8");
      await fs.writeFile(tiPath, ti, "utf8");
      writtenTo.json = jsonPath;
      writtenTo.ti = tiPath;
    }

    return jsonResult({
      processName,
      jsonFileName,
      tiFileName,
      parameterCount: pair.parameterCount,
      variableCount: pair.variableCount,
      dataSourceType: pair.dataSourceType,
      credentialsOmitted,
      hasSecurityAccess: pair.hasSecurityAccess,
      writtenTo,
      ...(warning ? { warning } : {}),
      // Echo the file bodies inline only when NOT persisting to disk. With
      // writeToDir the caller already has the files, so returning the code
      // would just duplicate thousands of tokens into the context window.
      ...(writeToDir ? {} : { json, ti: inlineTi }),
    });
  },
});
