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

export const SecurityRightSchema = z.enum([
  "NONE",
  "READ",
  "WRITE",
  "RESERVE",
  "LOCK",
  "ADMIN",
  "UNRESTRICTED",
]);
export type SecurityRight = z.infer<typeof SecurityRightSchema>;

export const ObjectSecurityRightSchema = z.object({
  objectName: z.string(),
  effective: SecurityRightSchema,
  grantedBy: z.array(z.string()),
  byGroup: z.record(z.string(), z.string()),
  cellSecurityActive: z.boolean().optional(),
  securityOverlayActive: z.boolean().optional(),
});
export type ObjectSecurityRight = z.infer<typeof ObjectSecurityRightSchema>;
