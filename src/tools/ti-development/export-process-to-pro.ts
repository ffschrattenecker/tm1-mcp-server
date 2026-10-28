import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveLocalPath } from "../local-file.js";
import { serializeToPro } from "../../lib/pro-serializer.js";
import {
  MASK_SECRETS_DESCRIPTION,
  maskCode,
  resolveMaskSecrets,
} from "../../lib/mask-secrets.js";
import { supportsCredentialExport } from "../../lib/credential-format.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { ExportProcessToProResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { jsonResult } from "../format.js";

export const registerExportProcessToPro = defineTool({
  name: "tm1_export_process_to_pro",
  description: [
    "Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body.",
    "Fetches code (Prolog/Metadata/Data/Epilog), parameters, variables (including the columns set to Ignore), and datasource in parallel.",
    "Returns the .pro content inline by default; pass writeToFile to also persist to an absolute path on the MCP host.",
    "A file written via writeToFile re-imports with tm1_import_pro_file.",
    "NOT a drop-in for the .pro file in TM1's Datadir: the output omits the BOM, the '601' header and CRLF. TM1 garbles a password written this way and then persists it, so the process looks configured and fails at runtime. Deploy via tm1_import_pro_file instead.",
  ],
  annotations: READ_ONLY,
  output: ExportProcessToProResultSchema,
  input: {
    processName: z.string().describe("Name of the TI process to export"),
    writeToFile: z
      .string()
      .optional()
      .describe(
        "Optional absolute host path to write the .pro file to. If omitted, content is only returned inline.",
      ),
    maskSecrets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        `${MASK_SECRETS_DESCRIPTION} Inline copy only; a file written via writeToFile stays unmasked.`,
      ),
    includeDataSourcePassword: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Write the ODBC datasource password into the file. v12 ONLY (v11 refuses it). Requires writeToFile. The value written is the PLAIN password: do not commit such a file.",
      ),
  },
  handler: async (
    { processName, writeToFile, maskSecrets, includeDataSourcePassword },
    tm1Client,
  ) => {
    if (includeDataSourcePassword && !writeToFile) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "includeDataSourcePassword requires writeToFile — the credential must go to a file, not into the inline response.",
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
          "includeDataSourcePassword is v12-only. On v11 the exported credential stops working when the TM1 service restarts, and the file gives no sign of it. To clone a process with its password inside this instance use tm1_copy_process; to deploy elsewhere or later, export without the password and pass dataSourcePassword to tm1_import_pro_file.",
      });
    }
    const [code, parameters, layout, dataSource, ui, meta] = await Promise.all([
      tm1Client.processes.getCode(processName),
      tm1Client.processes.getParameters(processName),
      tm1Client.processes.getVariableLayout(processName),
      tm1Client.processes.getDataSource(processName, {
        includeSecrets: includeDataSourcePassword === true,
      }),
      tm1Client.processes.getUIData(processName),
      tm1Client.processes.getDeployMeta(processName),
    ]);

    // Without the opt-in the service hands back a "[redacted]" marker, which
    // must not be written into the file as if it were the credential.
    if (!includeDataSourcePassword) delete dataSource.password;

    const credentialsIncluded = Boolean(
      includeDataSourcePassword && dataSource.password,
    );

    // The file is the deployable copy and gets the code as it is: a masked
    // literal would re-import as broken code ('***' instead of the password).
    // Masking applies to what goes back to the model — the inline body.
    const build = (mask: (s: string) => string) =>
      serializeToPro({
        name: processName,
        prolog: mask(code.prolog),
        metadata: mask(code.metadata),
        data: mask(code.data),
        epilog: mask(code.epilog),
        parameters,
        variables: layout.variables,
        ...(layout.variablesUIData !== undefined
          ? { variablesUIData: layout.variablesUIData }
          : {}),
        ...(ui.uiData !== undefined ? { uiData: ui.uiData } : {}),
        hasSecurityAccess: meta.hasSecurityAccess,
        dataSource,
      });
    const proContent = build((s) => s);
    const inlineContent = resolveMaskSecrets(maskSecrets)
      ? build(maskCode)
      : proContent;

    let writtenTo: string | null = null;
    if (writeToFile) {
      const target = resolveLocalPath(writeToFile, "writeToFile");
      // Create the parent directory only AFTER confinement above, so the
      // symlink-aware realpath check ran against the pre-existing tree.
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, proContent, "utf8");
      writtenTo = target;
    }

    return jsonResult({
      processName,
      byteLength: Buffer.byteLength(proContent, "utf8"),
      writtenTo,
      parameterCount: parameters.length,
      variableCount: layout.variables.length,
      dataSourceType: dataSource.type,
      credentialsIncluded,
      // Written to disk only when credentials are in play — otherwise
      // the caller already has the body and it stays out of the context.
      ...(includeDataSourcePassword ? {} : { content: inlineContent }),
    });
  },
});
