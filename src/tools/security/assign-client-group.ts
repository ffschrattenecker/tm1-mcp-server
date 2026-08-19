import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
export const registerAssignClientGroup = defineTool({
  name: "tm1_assign_client_group",
  description:
    "Assign a TM1 client to a group. Idempotent - assigning twice is a no-op.",
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    clientName: z.string().describe("Client (user) name"),
    groupName: z.string().describe("Group name"),
  },
  handler: async ({ clientName, groupName }, tm1Client) => {
    await tm1Client.security.assignClientGroup(clientName, groupName);
    return actionResponse({ success: true, clientName, groupName });
  },
});
