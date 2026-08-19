import { z } from "zod";
import { CompileErrorSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerCompileProcess = defineTool({
  name: "tm1_compile_process",
  description:
    "Compile a TI process to validate its syntax without executing it. Returns compile errors with line numbers and procedure (Prolog/Metadata/Data/Epilog) when present.",
  annotations: READ_ONLY,
  output: {
    ok: z.boolean(),
    processName: z.string(),
    errorCount: z.number().int(),
    errors: z.array(CompileErrorSchema),
  },
  input: {
    processName: z.string().describe("TI process name to compile"),
  },
  handler: async ({ processName }, tm1Client) => {
    const result = await tm1Client.processes.compile(processName);
    const payload = {
      ok: result.success,
      processName,
      errorCount: result.errors.length,
      errors: result.errors,
    };
    return {
      isError: !result.success || undefined,
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
