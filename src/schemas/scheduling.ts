// Chore domain.
import { z } from "zod";

export const ChoreSchema = z.object({
  name: z.string(),
  active: z.boolean(),
  startTime: z.string(),
  frequency: z.string(),
  processes: z.array(
    z.object({
      name: z.string(),
      parameters: z.record(z.string(), z.union([z.string(), z.number()])),
    }),
  ),
});
export type Chore = z.infer<typeof ChoreSchema>;
