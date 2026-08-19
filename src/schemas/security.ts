// Security domain. TM1 returns these entities with OData PascalCase keys, and
// the tool layer passes them through unchanged rather than renaming a shape
// callers may already match on.
import { z } from "zod";

export const ClientSchema = z.object({
  Name: z.string(),
  FriendlyName: z.string().optional(),
  Type: z.string().optional(),
  Enabled: z.boolean().optional(),
  Groups: z.array(z.object({ Name: z.string() })).optional(),
});
export type Client = z.infer<typeof ClientSchema>;

export const GroupSchema = z.object({
  Name: z.string(),
  Clients: z.array(z.object({ Name: z.string() })).optional(),
});
export type Group = z.infer<typeof GroupSchema>;
