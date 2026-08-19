import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerUpdateClient = defineTool({
  name: "tm1_update_client",
  description:
    "Update a TM1 client. Allowed fields: password, friendlyName, enabled (true=active, false=disabled).",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    clientName: z.string().describe("Client (user) name"),
    password: z.string().optional().describe("New password"),
    friendlyName: z.string().optional().describe("New display name"),
    enabled: z.boolean().optional().describe("Enable/disable the client"),
  },
  handler: async ({ clientName, ...payload }, tm1Client) => {
    await tm1Client.security.updateClient(clientName, payload);
    return actionResponse({ success: true, clientName });
  },
});
