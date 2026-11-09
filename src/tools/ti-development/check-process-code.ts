import { z } from "zod";
import type { ProcessParameter, ProcessVariable } from "../../types.js";
import { TM1ErrorCode } from "../../types.js";
import {
  DataSourceInputSchema,
  ProcessParameterSchema,
  ProcessVariableSchema,
} from "../../schemas/processes.js";
import { CompileErrorSchema, LintResultSchema } from "../schemas/items.js";
import { lintCode } from "./preflight.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { jsonResult } from "../format.js";

export const registerCheckProcessCode = defineTool({
  name: "tm1_check_process_code",
  description: [
    "Validate TI process code WITHOUT saving it on the server.",
    "Pre-flight check before tm1_upsert_process to avoid create-with-rollback patterns.",
    "Returns 'valid' or a list of syntax errors with procedure (Prolog/Metadata/Data/Epilog) and line number.",
    "Omitted tabs are validated as EMPTY: the result covers only tabsChecked, and partial=true says the check did not see a whole process — validate every tab you will install.",
    "lint lists code that compiles but runs wrong (function in the wrong tab, unreachable code, datasource set after the Prolog, literal secrets) plus a clearer cause for a trailing # comment. It is advisory and never changes ok; fix error findings, report the rest.",
  ],
  annotations: READ_ONLY,
  output: {
    ok: z.boolean(),
    processName: z.string(),
    errorCount: z.number().int(),
    errors: z.array(CompileErrorSchema),
    tabsChecked: z.array(z.string()),
    partial: z.boolean(),
    lint: LintResultSchema,
  },
  input: {
    processName: z
      .string()
      .optional()
      .describe(
        "Process name used in the synthetic body (no save). Default '_compile_check'.",
      ),
    prolog: z.string().optional(),
    metadata: z.string().optional(),
    data: z.string().optional(),
    epilog: z.string().optional(),
    parameters: z
      .array(ProcessParameterSchema)
      .optional()
      .describe(
        "TI parameters (Name, Type, defaultValue, optional Prompt). When omitted and baseProcess is set, inherited from baseProcess.",
      ),
    variables: z
      .array(ProcessVariableSchema)
      .optional()
      .describe(
        "TI variables (column mapping for ASCII/ODBC). When omitted and baseProcess is set, inherited from baseProcess.",
      ),
    dataSource: DataSourceInputSchema.optional().describe(
      "DataSource config — defaults to { type: 'None' } when omitted",
    ),
    baseProcess: z
      .string()
      .optional()
      .describe(
        "Existing process name to inherit parameters and variables from. Prevents 'undefined parameter' compile errors when validating code that references params defined on the saved process. Explicit parameters/variables override the inherited values.",
      ),
  },
  handler: async (
    {
      processName,
      prolog,
      metadata,
      data,
      epilog,
      parameters,
      variables,
      dataSource,
      baseProcess,
    },
    tm1Client,
  ) => {
    let resolvedParams: ProcessParameter[] | undefined = parameters;
    let resolvedVars: ProcessVariable[] | undefined = variables;
    if (baseProcess) {
      if (!resolvedParams)
        resolvedParams = await tm1Client.processes.getParameters(baseProcess);
      if (!resolvedVars)
        resolvedVars = await tm1Client.processes.getVariables(baseProcess);
    }
    const result = await tm1Client.processes.check({
      ...(processName !== undefined ? { name: processName } : {}),
      ...(prolog !== undefined ? { prolog } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(epilog !== undefined ? { epilog } : {}),
      ...(resolvedParams !== undefined ? { parameters: resolvedParams } : {}),
      ...(resolvedVars !== undefined ? { variables: resolvedVars } : {}),
      ...(dataSource !== undefined ? { dataSource: dataSource } : {}),
    });
    // Syntax errors are the expected output of a validator, so the failure
    // payload carries its own code/message/hint — otherwise the isError
    // normalizer stamps a generic TM1_ERROR envelope over it.
    // Omitted tabs compile as empty, so a clean result on a fragment says
    // nothing about the tabs that were left out — report what was covered.
    const provided = { prolog, metadata, data, epilog };
    const tabsChecked = (
      Object.keys(provided) as Array<keyof typeof provided>
    ).filter((t) => provided[t] !== undefined);
    const name = processName ?? "_compile_check";
    const partial = tabsChecked.length < 4;
    const payload = {
      ok: result.success,
      processName: name,
      errorCount: result.errors.length,
      errors: result.errors,
      tabsChecked,
      partial,
      lint: lintCode(name, provided, partial),
      ...(result.success
        ? {}
        : {
            code: TM1ErrorCode.VALIDATION_ERROR,
            message: `TI syntax check failed: ${result.errors.length} error(s)`,
            hint: "Nothing was saved. Fix the lines listed in errors[] (procedure + lineNumber) and re-run tm1_check_process_code before tm1_upsert_process.",
          }),
    };
    return {
      ...jsonResult(payload),
      isError: !result.success || undefined,
    };
  },
});
