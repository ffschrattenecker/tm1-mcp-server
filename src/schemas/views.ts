// View domain: the dimension/subset reference shared by axes and titles.
import { z } from "zod";

export const ViewAxisSubsetRefSchema = z.object({
  dimensionName: z.string().optional(),
  hierarchyName: z.string().optional(),
  subsetName: z.string().optional(),
  expression: z.string().optional(),
});
export type ViewAxisSubsetRef = z.infer<typeof ViewAxisSubsetRefSchema>;
