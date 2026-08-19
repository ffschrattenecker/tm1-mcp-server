import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerUpdateChore = defineTool({
  name: "tm1_update_chore",
  description:
    "Update an existing TM1 chore. Only the provided fields are changed.",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    choreName: z.string().describe("Chore name (case-sensitive)"),
    startTime: z
      .string()
      .optional()
      .describe("New start time in ISO 8601 format"),
    active: z
      .boolean()
      .optional()
      .describe("Enable or disable the chore schedule"),
    dstSensitive: z
      .boolean()
      .optional()
      .describe("Adjust for daylight saving time"),
    executionMode: z.enum(["SingleCommit", "MultipleCommit"]).optional(),
    frequency: z
      .object({
        days: z.number().int().min(0),
        hours: z.number().int().min(0).max(23),
        minutes: z.number().int().min(0).max(59),
        seconds: z.number().int().min(0).max(59),
      })
      .optional(),
    steps: z
      .array(
        z.object({
          process: z.string(),
          parameters: z
            .array(
              z.object({
                name: z.string(),
                value: z.union([z.string(), z.number()]),
              }),
            )
            .optional()
            .default([]),
        }),
      )
      .optional()
      .describe("Replace all steps (full replacement, not partial)"),
  },
  handler: async ({ choreName, ...updates }, tm1Client) => {
    let coerced = false;
    if (
      updates.startTime !== undefined &&
      !/(?:Z|[+-]\d{2}:?\d{2})$/.test(updates.startTime)
    ) {
      updates.startTime = `${updates.startTime}Z`;
      coerced = true;
    }
    await tm1Client.chores.update(choreName, updates);
    const payload = {
      success: true,
      choreName,
      ...(updates.startTime !== undefined
        ? { startTime: updates.startTime }
        : {}),
      ...(coerced
        ? {
            warning: `startTime had no timezone offset; auto-appended 'Z' → '${updates.startTime}'. Pass an explicit offset to silence this.`,
          }
        : {}),
    };
    return actionResponse(payload);
  },
});
