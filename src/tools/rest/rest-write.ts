// tm1_rest_write: guarded generic POST/PATCH/PUT/DELETE against /api/v1/.
//
// Replaces the one-request create/update/delete tools. ./guard.ts refuses
// whatever a kept tool owns (process writes, execution, rules, cells, files,
// $batch, SaveData/Clear) and names that tool; DELETE and cancel/close
// actions need confirm = the key of the object they hit. Non-GET requests are
// never retried by the transport, so a dropped call is not replayed — and its
// outcome is unknown, which the error hint says instead of "retry".
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { DESTRUCTIVE } from "../annotations.js";
import { requireConfirm } from "../confirm.js";
import { defineTool } from "../define-tool.js";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { planWrite } from "./guard.js";
import { dataBudget, ENVELOPE_CHARS, shapeBody } from "./shape.js";

// A write's echo (e.g. the created entity) is context, not the point.
const RESPONSE_MAX_CHARS = 20_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

const OUTCOME_UNKNOWN = new Set<TM1ErrorCode>([
  TM1ErrorCode.LOCK_TIMEOUT,
  TM1ErrorCode.CONNECTION_FAILED,
]);

export const registerRestWrite = defineTool({
  name: "tm1_rest_write",
  description: [
    "POST/PATCH/PUT/DELETE a TM1 REST path (relative to /api/v1/), e.g. POST Dimensions, PATCH Chores('X') {Active}, POST Cubes('C')/tm1.Unload, DELETE Cubes('C')/Views('V').",
    "DELETE and tm1.Cancel/CancelOperation need confirm = the last key in the path (the $id key for …?$id=…).",
    "Refused, with the tool to use: process writes, Execute*, Rules, Cellsets/tm1.Update, SaveData/Clear, Contents/Files/Blobs, $batch.",
    "Not retried: after a timeout the outcome is unknown; check with tm1_rest_read before re-sending.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
    path: z
      .string()
      .min(1)
      .describe("Path relative to /api/v1/, e.g. Cubes('Sales')/Views."),
    body: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(z.unknown()),
        z.string(),
      ])
      .optional()
      .describe("JSON request body (not for DELETE); a JSON string is parsed."),
    confirm: z
      .string()
      .optional()
      .describe(
        "DELETE / cancel only: repeat the target key verbatim, e.g. 'Region' for Dimensions('Region').",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe("Request timeout override."),
  },
  handler: async (
    { method, path, body, confirm, timeoutMs },
    tm1Client,
    extra,
  ) => {
    const plan = planWrite(method, path, body);
    if (plan.confirmTarget !== undefined) {
      requireConfirm(confirm, plan.confirmTarget, "object");
    }
    let res;
    try {
      res = await tm1Client.rest.send(method, plan.path, plan.body, {
        signal: extra?.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (err) {
      if (err instanceof TM1Error && OUTCOME_UNKNOWN.has(err.code)) {
        err.hintOverride = `The ${method} may or may not have been applied: outcome unknown. Check the target with tm1_rest_read before re-sending.`;
      }
      throw err;
    }
    const shaped =
      res.kind === "empty"
        ? {}
        : shapeBody(
            res,
            // success/method/path sit next to the echo in the envelope.
            dataBudget(
              RESPONSE_MAX_CHARS,
              ENVELOPE_CHARS + JSON.stringify(plan.path).length,
            ),
            {
              secret: plan.maskSecret === true,
            },
          );
    return actionResponse({
      success: true,
      method,
      path: plan.path,
      ...shaped,
    });
  },
});
