import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";
import { dataSourceSchema as sharedDataSourceSchema } from "../../lib/process-parts-schema.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { UpsertProcessResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { preflightResult, runPreflight } from "./preflight.js";

// The same data source shape the git round-trip and check_process_code use.
// This tool used to carry its own copy, which had drifted: it was missing
// `query`, so an ODBC source could be created here but its SQL could not —
// while tm1_get_process_datasource reads it back.
// Strict, so a misspelled field is rejected instead of silently dropped.
const dataSourceSchema = sharedDataSourceSchema.strict();

const parameterSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

const variableSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  position: z.number().int().positive(),
  startByte: z.number().int().optional(),
  endByte: z.number().int().optional(),
});

export const registerUpsertProcess = defineTool({
  name: "tm1_upsert_process",
  description:
    "Atomic-style create-or-update for a TI process. Bundles createProcess (if missing) + updateProcessCode + updateProcessParameters + updateProcessVariables + updateProcessDataSource into a single MCP call. NOTE: TM1 itself does not support a real transaction — on partial failure, the steps that already succeeded are not rolled back. The tool reports which step failed.",
  annotations: IDEMPOTENT_WRITE,
  output: UpsertProcessResultSchema,
  input: {
    processName: z.string(),
    prolog: z.string().optional(),
    metadata: z.string().optional(),
    data: z.string().optional(),
    epilog: z.string().optional(),
    parameters: z.array(parameterSchema).optional(),
    variables: z.array(variableSchema).optional(),
    dataSource: dataSourceSchema.optional(),
    hasSecurityAccess: z
      .boolean()
      .optional()
      .describe(
        "When set, applies the process's HasSecurityAccess flag via a dedicated PATCH after the other steps.",
      ),
    mode: z.enum(["create", "update", "upsert"]).optional().default("upsert"),
    preflight: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Before writing, run the syntax check AND the reference check on the process as it will be after this call (omitted tabs, parameters and variables keep their installed values). Abort on either. Default true. false skips both.",
      ),
    autoCompile: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "After deploy, run tm1.Compile and include the result in the response (compile: {ok, errorCount, errors}). Off by default — compile holds a brief lock on the process and serializes badly under bulk-deploy.",
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
      hasSecurityAccess,
      mode,
      preflight,
      autoCompile,
    },
    tm1Client,
  ) => {
    const trail: string[] = [];
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

    if (preflight) {
      // Check the process as it will stand after this call, not the fields
      // the caller happened to send: an omitted tab keeps its installed code.
      const current = exists
        ? await tm1Client.processes.getCode(processName)
        : { prolog: "", metadata: "", data: "", epilog: "" };
      const failure = await runPreflight(tm1Client, {
        name: processName,
        prolog: prolog ?? current.prolog,
        metadata: metadata ?? current.metadata,
        data: data ?? current.data,
        epilog: epilog ?? current.epilog,
        parameters:
          parameters ??
          (exists ? await tm1Client.processes.getParameters(processName) : []),
        variables:
          variables !== undefined && variables.length > 0
            ? variables
            : exists
              ? await tm1Client.processes.getVariables(processName)
              : [],
        ...(dataSource !== undefined ? { dataSource } : {}),
      });
      if (failure) return preflightResult(failure);
    }

    if (!exists) {
      await tm1Client.processes.create(processName);
      trail.push("createProcess");
    }

    if (
      prolog !== undefined ||
      metadata !== undefined ||
      data !== undefined ||
      epilog !== undefined
    ) {
      await tm1Client.processes.updateCode(processName, {
        ...(prolog !== undefined ? { prolog } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(epilog !== undefined ? { epilog } : {}),
      });
      trail.push("updateProcessCode");
    }
    if (parameters !== undefined) {
      await tm1Client.processes.updateParameters(processName, parameters);
      trail.push("updateProcessParameters");
    }
    if (variables !== undefined && variables.length > 0) {
      await tm1Client.processes.updateVariables(processName, variables);
      trail.push("updateProcessVariables");
    }
    if (dataSource !== undefined) {
      await tm1Client.processes.updateDataSource(processName, dataSource);
      trail.push("updateProcessDataSource");
    }
    if (hasSecurityAccess !== undefined) {
      await tm1Client.processes.updateSecurityAccess(
        processName,
        hasSecurityAccess,
      );
      trail.push("updateSecurityAccess");
    }

    // Process body/parameters/datasource may have changed call sites — drop the
    // 60s callgraph TTL so the next analysis sees fresh references instead of stale graph.
    const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();

    let compile:
      { ok: boolean; errorCount: number; errors: unknown[] } | undefined;
    if (autoCompile) {
      const result = await tm1Client.processes.compile(processName);
      compile = {
        ok: result.success,
        errorCount: result.errors.length,
        errors: result.errors,
      };
      trail.push("compileProcess");
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              processName,
              action: exists ? "updated" : "created",
              appliedSteps: trail,
              callgraphEntriesCleared,
              ...(compile !== undefined ? { compile } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
