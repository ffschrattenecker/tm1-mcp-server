import { promises as fs } from "node:fs";
import { resolveLocalPath } from "../local-file.js";
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";
import { ignoredColumnsOf } from "../../lib/variables-ui-data.js";
import { tabCodeDiff } from "../../lib/line-diff.js";
import {
  MASK_SECRETS_DESCRIPTION,
  maskCode,
  resolveMaskSecrets,
} from "../../lib/mask-secrets.js";
import {
  diffDs,
  diffIgnoredColumns,
  diffParams,
  diffVars,
} from "./diff-processes.js";
import { DiffProcessResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { jsonResult } from "../format.js";

// The shared diffs label their two sides a/b; this tool reports installed/file.
function installedFile<C extends { a?: unknown; b?: unknown }>({
  a,
  b,
  ...rest
}: C) {
  return { ...rest, installed: a, file: b };
}

export const registerDiffProcessWithFile = defineTool({
  name: "tm1_diff_process_with_file",
  description:
    "Compare an installed TI process on the server against a local .pro file. Returns per-tab identical flags, line counts and unified diff hunks, parameter diff (added/removed/changed), variable diff, and datasource diff. Use before tm1_import_pro_file to preview what will change.",
  annotations: READ_ONLY,
  output: DiffProcessResultSchema,
  input: {
    filePath: z
      .string()
      .optional()
      .describe(
        "Absolute path to the .pro file on the MCP server host. Otherwise pass 'content' inline.",
      ),
    content: z.string().optional().describe("Raw .pro file content as string"),
    processName: z
      .string()
      .optional()
      .describe("Override process name. Default: from .pro 602 line."),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe(
        "Lines of context around each changed hunk (default 3, max 10)",
      ),
    maskSecrets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        `${MASK_SECRETS_DESCRIPTION} Applied to both sides before diffing, so a credential on one side cannot leak through the diff.`,
      ),
  },
  handler: async (
    { filePath, content, processName, contextLines, maskSecrets },
    tm1Client,
  ) => {
    if (!filePath && !content) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Provide filePath or content",
      });
    }
    let body = content ?? "";
    if (!body && filePath) {
      body = await fs.readFile(resolveLocalPath(filePath), "utf8");
    }

    const parsed = parseProFile(body);
    const name = processName ?? parsed.name;
    if (!name) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Process name not found in .pro and no override provided",
      });
    }

    const [installedCode, installedParams, installedLayout, installedDs] =
      await Promise.all([
        tm1Client.processes.getCode(name),
        tm1Client.processes.getParameters(name),
        tm1Client.processes.getVariableLayout(name),
        tm1Client.processes.getDataSource(name),
      ]);

    const mask = resolveMaskSecrets(maskSecrets) ? maskCode : (s: string) => s;
    const tabs = (["prolog", "metadata", "data", "epilog"] as const).map(
      (tab) => ({
        tab,
        ...tabCodeDiff(
          mask(installedCode[tab]),
          mask(parsed[tab]),
          contextLines,
        ),
      }),
    );
    const parameters = diffParams(installedParams, parsed.parameters);
    const variables = diffVars(installedLayout.variables, parsed.variables);
    const ignoredColumns = diffIgnoredColumns(
      installedLayout.ignoredColumns,
      ignoredColumnsOf(parsed.variablesUIData ?? []),
    );
    const dataSource = diffDs(installedDs, parsed.dataSource);

    const identical =
      tabs.every((t) => t.identical) &&
      parameters.identical &&
      variables.identical &&
      ignoredColumns.identical &&
      dataSource.identical;

    return jsonResult({
      processName: name,
      identical,
      tabs,
      parameters: {
        ...parameters,
        changed: parameters.changed.map(installedFile),
      },
      variables: {
        ...variables,
        changed: variables.changed.map(installedFile),
      },
      ignoredColumns: {
        ...ignoredColumns,
        renamed: ignoredColumns.renamed.map(installedFile),
      },
      dataSource,
    });
  },
});
