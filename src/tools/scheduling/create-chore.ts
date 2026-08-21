import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";

// TM1's chore endpoint rejects DateTimeOffset strings without a UTC marker. If the caller
// omits the offset we append 'Z' and report it back so they can fix the input upstream.
function coerceUtc(iso: string): { value: string; coerced: boolean } {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return hasOffset
    ? { value: iso, coerced: false }
    : { value: `${iso}Z`, coerced: true };
}

const ChoreStepSchema = z.object({
  process: z.string().describe("TI process name"),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        value: z.union([z.string(), z.number()]),
      }),
    )
    .optional()
    .default([]),
});

export const registerCreateChore = defineTool({
  name: "tm1_create_chore",
  description: [
    "Create a new TM1 chore with a schedule and list of TI processes to run.",
    "Fails if a chore with the same name already exists; use tm1_update_chore for idempotent edits.",
    "After: tm1_toggle_chore to activate scheduling, tm1_execute_chore to run immediately.",
  ],
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    choreName: z.string().describe("Chore name"),
    startTime: z
      .string()
      .describe(
        "Start time in ISO 8601 format with timezone (Z or ±HH:MM). If no offset is given, UTC ('Z') is auto-appended. Example: '2025-01-01T06:00:00Z'.",
      ),
    active: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether to activate the chore immediately (default: false)"),
    dstSensitive: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Whether the schedule adjusts for daylight saving time (default: true)",
      ),
    executionMode: z
      .enum(["SingleCommit", "MultipleCommit"])
      .optional()
      .default("MultipleCommit")
      .describe(
        "SingleCommit: the chore commits once at the end. MultipleCommit: each step commits independently. " +
          "Measured (12.5.9): the mode changes only how far a ProcessRollback reaches — under SingleCommit it discards everything the chore wrote up to that point, under MultipleCommit only the rolling-back step. " +
          "Under NEITHER mode does a failing step stop the chore: later steps still run and still commit.",
      ),
    frequency: z
      .object({
        days: z.number().int().min(0).default(1),
        hours: z.number().int().min(0).max(23).default(0),
        minutes: z.number().int().min(0).max(59).default(0),
        seconds: z.number().int().min(0).max(59).default(0),
      })
      .describe("How often the chore runs"),
    steps: z
      .array(ChoreStepSchema)
      .min(1)
      .describe("Ordered list of TI processes to execute"),
  },
  handler: async (
    {
      choreName,
      startTime,
      active,
      dstSensitive,
      executionMode,
      frequency,
      steps,
    },
    tm1Client,
  ) => {
    const { value: normalizedStartTime, coerced } = coerceUtc(startTime);
    await tm1Client.chores.create({
      name: choreName,
      startTime: normalizedStartTime,
      active,
      dstSensitive,
      executionMode,
      frequency,
      steps,
    });
    return actionResponse({
      success: true,
      name: choreName,
      stepCount: steps.length,
      active,
      startTime: normalizedStartTime,
      ...(coerced
        ? {
            warning: `startTime had no timezone offset; auto-appended 'Z' → '${normalizedStartTime}'. Pass an explicit offset to silence this.`,
          }
        : {}),
    });
  },
});
