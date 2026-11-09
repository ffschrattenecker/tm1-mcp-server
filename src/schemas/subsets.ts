// Subset domain.
import { z } from "zod";

export const SubsetSchema = z.object({
  name: z.string(),
  dimensionName: z.string(),
  hierarchyName: z.string(),
  private: z.boolean(),
  expression: z.string().optional(),
  elements: z.array(z.string()),
  alias: z.string().optional(),
});
export type Subset = z.infer<typeof SubsetSchema>;
