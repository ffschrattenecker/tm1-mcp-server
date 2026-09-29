// tm1_rest_read: guarded generic GET against the TM1 REST API (/api/v1/).
//
// Replaces the one-request list/get tools. READ_ONLY, so it stays registered
// on readonly connections — which is also why Processes('P')/tm1.Compile, the
// single read-only POST, is routed through here and not tm1_rest_write.
// What may be requested is decided by ./guard.ts; ./shape.ts strips, masks
// and cuts the body to maxChars — never past the configured response limit.
import { z } from "zod";
import { DEFAULT_MAX_RESPONSE_CHARS } from "../../config.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { planRead } from "./guard.js";
import { dataBudget, ENVELOPE_CHARS, shapeBody } from "./shape.js";

const DEFAULT_MAX_CHARS = 30_000;
// Schema bound against the default limit. The effective budget is also capped
// at call time by the configured TM1_MAX_RESPONSE_CHARS (see dataBudget).
const HARD_MAX_CHARS = DEFAULT_MAX_RESPONSE_CHARS - 10_000;

export const RestReadResultSchema = z.object({
  truncated: z.boolean(),
  data: z.unknown().optional(),
  text: z.string().optional(),
  count: z.number().optional(),
  kept: z.number().int().optional(),
  total: z.number().int().optional(),
  truncatedAt: z.string().optional(),
  totalChars: z.number().int().optional(),
});

export const registerRestRead = defineTool({
  name: "tm1_rest_read",
  description: [
    "GET any TM1 REST path (relative to /api/v1/), plus POST Processes('P')/tm1.Compile.",
    "Returns data (@odata.* removed, secrets masked) or text for non-JSON bodies; over maxChars the value[] (or largest array) is cut: truncated, kept/total.",
    "Narrow with $select/$filter/$expand/$top; $count=true adds count.",
    "Paths: Cubes('C')?$expand=Dimensions($select=Name); Dimensions('D')/Hierarchies('H')/Elements?$select=Name,Type&$filter=Type eq 'Consolidated'&$top=50 (…/Elements/$count);",
    "…/Hierarchies('H')/Subsets; Cubes('C')/Views; Chores?$expand=Tasks; Users?$expand=Groups($select=Name); Groups; Threads; Sessions;",
    "MessageLogEntries?$orderby=TimeStamp desc&$top=50 (also TransactionLogEntries, AuditLogEntries); ErrorLogFiles('f')/Content; Configuration; ActiveConfiguration.",
    "Cellsets, Execute* and $batch are refused with the tool to use.",
  ],
  annotations: READ_ONLY,
  output: RestReadResultSchema,
  input: {
    path: z
      .string()
      .min(1)
      .describe(
        "Path relative to /api/v1/ with query options, e.g. Cubes?$select=Name.",
      ),
    maxChars: z
      .number()
      .int()
      .min(1_000)
      .max(HARD_MAX_CHARS)
      .optional()
      .default(DEFAULT_MAX_CHARS)
      .describe(
        `Response character budget (default ${DEFAULT_MAX_CHARS}; capped by the server's response limit).`,
      ),
  },
  handler: async ({ path, maxChars }, tm1Client, extra) => {
    const plan = planRead(path);
    const opts = { signal: extra?.signal };
    const body =
      plan.method === "POST"
        ? await tm1Client.rest.send("POST", plan.path, undefined, opts)
        : await tm1Client.rest.get(plan.path, opts);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            shapeBody(body, dataBudget(maxChars, ENVELOPE_CHARS), {
              code: plan.maskCode === true,
              secret: plan.maskSecret === true,
            }),
          ),
        },
      ],
    };
  },
});
