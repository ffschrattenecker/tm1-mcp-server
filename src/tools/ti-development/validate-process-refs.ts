import { promises as fs } from "node:fs";
import { resolveLocalPath } from "../local-file.js";
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { parseProFile } from "../../lib/pro-parser.js";
import { checkProcessRefs, type ProcessCode } from "../../lib/process-refs.js";
import { READ_ONLY } from "../annotations.js";
import { ValidateProcessRefsResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerValidateProcessRefs = defineTool({
  name: "tm1_validate_process_refs",
  description: [
    "Scan a TI process (live, by name, or from .pro) for cube/dimension references in well-known TI functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementInsertDirect, AttrPutS, etc.) and verify each name resolves on the server. TM1 lets syntactically valid code reference non-existent objects — this catches the gap between compile and runtime.",
    "Existence probes (DimensionExists, CubeExists, …) and names the code itself creates (CubeCreate/DimensionCreate) are not flagged.",
    "partial=true means some names are passed as parameters or computed values and could not be checked (see unresolvableArgs). The install tools run this same check in their preflight.",
  ],
  annotations: READ_ONLY,
  output: ValidateProcessRefsResultSchema,
  input: {
    processName: z
      .string()
      .optional()
      .describe("Validate an installed process by name"),
    filePath: z
      .string()
      .optional()
      .describe(
        "Validate a .pro file (absolute host path). Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within that directory. Otherwise pass 'content' inline.",
      ),
    content: z.string().optional().describe("Validate raw .pro content"),
    includeControl: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Include control objects ('}'-prefixed) as valid targets. Default true.",
      ),
  },
  handler: async (
    { processName, filePath, content, includeControl },
    tm1Client,
  ) => {
    if (!processName && !filePath && !content) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Provide processName, filePath, or content",
      });
    }

    let code: ProcessCode;
    let resolvedName = processName ?? "";
    if (processName) {
      code = await tm1Client.processes.getCode(processName);
    } else {
      let body = content ?? "";
      if (!body && filePath) {
        body = await fs.readFile(resolveLocalPath(filePath), "utf8");
      }
      const parsed = parseProFile(body);
      code = {
        prolog: parsed.prolog,
        metadata: parsed.metadata,
        data: parsed.data,
        epilog: parsed.epilog,
      };
      resolvedName = parsed.name ?? "(from-file)";
    }

    const report = await checkProcessRefs(tm1Client, code, { includeControl });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { processName: resolvedName, ...report },
            null,
            2,
          ),
        },
      ],
    };
  },
});
