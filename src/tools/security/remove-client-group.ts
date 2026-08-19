import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerRemoveClientGroup = defineTool({
  name: "tm1_remove_client_group",
  description: [
    "Remove a TM1 client from a group.",
    "Inverse of tm1_assign_client_group. Before: tm1_get_client to inspect current group memberships.",
    "Safety: pass confirm=<client name verbatim>.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    clientName: z.string().describe("Client (user) name"),
    groupName: z.string().describe("Group name"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ clientName, groupName, confirm }, tm1Client) => {
    requireConfirm(confirm, clientName, "client");
    await tm1Client.security.removeClientGroup(clientName, groupName);
    return actionResponse({ success: true, clientName, groupName });
  },
});
