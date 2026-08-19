// Cell/MDX domain: axis tuples and the feeder cell descriptor.
import { z } from "zod";

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
