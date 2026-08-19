import { z } from "zod";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";
import { ClientItemSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetClient = defineTool({
  name: "tm1_get_client",
  description:
    "Get details for a single TM1 client (user) including group memberships.",
  annotations: READ_ONLY,
  output: ClientItemSchema,
  input: {
    clientName: z.string().describe("Client (user) name"),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ clientName, format }, tm1Client) => {
    const client = await tm1Client.security.getClient(clientName);
    return payloadResponse(client, format, (c) =>
      renderKV(c as unknown as Record<string, unknown>, `Client ${clientName}`),
    );
  },
});
