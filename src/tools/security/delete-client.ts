import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerDeleteClient = defineTool({
  name: "tm1_delete_client",
  description:
    "Delete a TM1 client (user). Irreversible - the client must not have active sessions. Pass confirm=<client name verbatim>.",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    clientName: z.string().describe("Client (user) name"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ clientName, confirm }, tm1Client) => {
    requireConfirm(confirm, clientName, "client");
    await tm1Client.security.deleteClient(clientName);
    return actionResponse({ success: true, clientName });
  },
});
