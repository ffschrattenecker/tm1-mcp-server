// Scheduling-domain schema: chore list item for tm1_list_chores.
import { z } from "zod";
import { ChoreSchema } from "../../schemas/scheduling.js";

// In compact mode (tm1_list_chores compact=true) the full processes[] array is
// replaced by processCount, so both are optional at schema level; the tool
// guarantees exactly one is present.
export const ChoreItemSchema = ChoreSchema.partial({ processes: true }).extend({
  processCount: z.number().int().optional(),
});
