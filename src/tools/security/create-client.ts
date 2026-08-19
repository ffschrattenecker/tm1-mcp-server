import { z } from "zod";
import { actionResponse } from "../format.js";
import { MutationResultSchema } from "../schemas/items.js";
import { WRITE } from "../annotations.js";
import { defineTool } from "../define-tool.js";
export const registerCreateClient = defineTool({
  name: "tm1_create_client",
  description:
    "Create a new TM1 client (user). Optionally set initial password, friendly name, and group memberships.",
  annotations: WRITE,
  output: MutationResultSchema,
  input: {
    clientName: z.string().describe("Client (user) name"),
    password: z
      .string()
      .optional()
      .describe("Initial password (omit if external auth)"),
    friendlyName: z.string().optional().describe("Display name"),
    groups: z
      .array(z.string())
      .optional()
      .describe("Group names to assign on creation"),
  },
  handler: async ({ clientName, ...rest }, tm1Client) => {
    await tm1Client.security.createClient({ name: clientName, ...rest });
    return actionResponse({ success: true, name: clientName });
  },
});
