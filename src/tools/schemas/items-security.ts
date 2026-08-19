// Security-domain schemas: client and group list items.
import { z } from "zod";
import { ClientSchema, GroupSchema } from "../../schemas/security.js";

// The list tools add a count field in compact mode; passthrough because the
// security entities carry server-specific extras.
export const ClientItemSchema = ClientSchema.extend({
  groupCount: z.number().int().optional(),
}).passthrough();

export const GroupItemSchema = GroupSchema.extend({
  clientCount: z.number().int().optional(),
}).passthrough();
