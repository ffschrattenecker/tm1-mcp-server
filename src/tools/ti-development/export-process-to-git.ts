import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { supportsCredentialExport } from "../../lib/credential-format.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";
import { serializeProcessToGit } from "../../lib/git-process.js";
import { maskCode, resolveMaskSecrets } from "../../lib/mask-secrets.js";
import { ExportProcessToGitResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerExportProcessToGit = defineTool({
  name: "tm1_export_process_to_git",
  description: [
    "Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' (parameters, variables, ignored datasource columns, datasource) plus a '{name}.ti' (Prolog/Metadata/Data/Epilog as plain code).",
    "The .ti holds the code in TM1's native `Code` representation (#region <Tab> / #endregion, CRLF, empty tabs omitted); the .json holds the structure. Code lives outside the JSON so Git diffs stay readable.",
    "Returns both file bodies (json + ti) inline by default. Pass writeToDir to persist them to disk instead: the code is then written to files and omitted from the response to avoid duplicating it into the context window; only metadata (filenames, counts, writtenTo paths) comes back. Files written via writeToDir are round-trip safe with tm1_import_process_from_git; the inline .ti has credential literals masked by default and is for reading, not re-importing.",
    "Security: the ODBC datasource password is stripped unless includeDataSourcePassword is set (which also requires writeToDir); credential literals in the TI code are masked in the inline response when maskSecrets is on, never in written files (those must re-import intact); credentialsOmitted=true flags when a password was stripped.",
    "includeDataSourcePassword is v12-only: what v11 hands out expires with the server run, so exporting it would produce a file that looks complete and fails later.",
  ],
  annotations: READ_ONLY,
  output: ExportProcessToGitResultSchema,
  input: {
    processName: z.string().describe("Name of the TI process to export"),
    writeToDir: z
      .string()
      .optional()
      .describe(
        "Optional absolute host directory to write '{name}.json' and '{name}.ti' into. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. If omitted, content is only returned inline.",
      ),
    maskSecrets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Redact credential literals in the .ti code returned INLINE (password arg of ODBCOpen(), quoted values assigned to credential-named identifiers such as pPwd or sToken). Default: true. Files written via writeToDir always hold the code unmasked, so they re-import intact — treat them as containing any password literal the code has.",
      ),
    includeDataSourcePassword: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Write the ODBC datasource password into the .json. Off by default, and v12 ONLY — on v11 it is refused, because the credential v11 hands out expires with the server run and would leave a .json that looks complete and fails at connect time; clone with tm1_copy_process instead, or deploy with tm1_import_process_from_git's dataSourcePassword. On v12 the value written is the PLAIN password, in a layout meant for version control — requires writeToDir, and do not commit the result.",
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
    const [codeBlob, parameters, layout, dataSource, deployMeta] =
      await Promise.all([
        tm1Client.processes.getCodeBlob(processName),
        tm1Client.processes.getParameters(processName),
        tm1Client.processes.getVariableLayout(processName),
        tm1Client.processes.getDataSource(processName, {
          includeSecrets: includeDataSourcePassword === true,
        }),
        tm1Client.processes.getDeployMeta(processName),
      ]);

    // The file is the deployable copy and gets the code as it is: a masked
    // literal would re-import as broken code ('***' instead of the password).
    // Masking applies to what goes back to the model — the inline body.
    const ti = codeBlob;
    const inlineTi = resolveMaskSecrets(maskSecrets) ? maskCode(ti) : ti;
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
      { includePassword: includeDataSourcePassword === true },
    );

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

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            processName,
            jsonFileName,
            tiFileName,
            parameterCount: parameters.length,
            variableCount: layout.variables.length,
            dataSourceType: dataSource.type,
            credentialsOmitted,
            hasSecurityAccess: deployMeta.hasSecurityAccess,
            writtenTo,
            // Echo the file bodies inline only when NOT persisting to disk. With
            // writeToDir the caller already has the files, so returning the code
            // would just duplicate thousands of tokens into the context window.
            ...(writeToDir ? {} : { json, ti: inlineTi }),
          }),
        },
      ],
    };
  },
});
