// Cell/MDX domain: axis tuples, cell metadata, MDX set tuples, and feeder descriptors.
import { z } from "zod";
import { CellValueSchema } from "./common.js";

export const CellMetadataPropertySchema = z.enum([
  "RuleDerived",
  "Updateable",
  "HasPicklist",
]);
export type CellMetadataProperty = z.infer<typeof CellMetadataPropertySchema>;

export const CellItemSchema = z.object({
  value: CellValueSchema,
  formattedValue: z.string(),
  ruleDerived: z.boolean().optional(),
  updateable: z.boolean().optional(),
  updateableBitmask: z.number().int().optional(),
  hasPicklist: z.boolean().optional(),
});
export type CellItem = z.infer<typeof CellItemSchema>;

export const MdxSetMemberSchema = z.object({
  name: z.string(),
  uniqueName: z.string().optional(),
  type: z.string().optional(),
  level: z.number().int().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type MdxSetMember = z.infer<typeof MdxSetMemberSchema>;

export const MdxSetTupleSchema = z.object({
  ordinal: z.number().int(),
  members: z.array(MdxSetMemberSchema),
});
export type MdxSetTuple = z.infer<typeof MdxSetTupleSchema>;

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
