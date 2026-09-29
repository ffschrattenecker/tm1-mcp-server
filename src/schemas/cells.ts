// Cell/MDX domain: axis tuples and the feeder cell descriptor.
import { z } from "zod";
import { CellValueSchema } from "./common.js";

export const MdxAxisSchema = z.object({
  tuples: z.array(
    z.object({
      members: z.array(
        z.object({ name: z.string(), hierarchyName: z.string() }),
      ),
    }),
  ),
});
export type MdxAxis = z.infer<typeof MdxAxisSchema>;

export const FedCellDescriptorSchema = z.object({
  cube: z.string(),
  tuple: z.array(z.string()),
  fed: z.boolean(),
});
export type FedCellDescriptor = z.infer<typeof FedCellDescriptorSchema>;

// Live state of one cell, read plain and then under NON EMPTY. Under SKIPCHECK
// an unfed rule cell still computes its value but NON EMPTY drops it.
// fed: true = kept; false = has a value but dropped (unfed); null = empty or
// zero, so NON EMPTY cannot tell.
export const CellProbeSchema = z.object({
  tuple: z.array(z.string()),
  value: CellValueSchema,
  ruleDerived: z.boolean(),
  consolidated: z.boolean(),
  fed: z.boolean().nullable(),
});
export type CellProbe = z.infer<typeof CellProbeSchema>;
