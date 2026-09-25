import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { READ_ONLY } from "../annotations.js";

const ConnectionSchema = z.object({
  name: z.string(),
  mode: z.enum(["readwrite", "readonly"]).optional(),
  tm1Version: z.string().optional(),
  connected: z.boolean(),
  error: z.string().optional(),
});

export const registerListConnections = defineTool({
  name: "tm1_list_connections",
  description:
    "List the TM1 connections this server can reach: name (the `connection` argument of every other tool), readonly/readwrite mode, TM1 version, and whether a session is open. Makes no TM1 call.",
  annotations: READ_ONLY,
  output: z.object({ connections: z.array(ConnectionSchema) }),
  input: {},
  connectionless: true,
  handler: (_args, registry) => {
    const connections = registry.status().map((c) => ({
      name: c.name,
      ...(c.mode && { mode: c.mode }),
      ...(c.tm1Version && { tm1Version: c.tm1Version }),
      connected: c.connected,
      ...((c.configError ?? c.lastError) && {
        error: c.configError ?? c.lastError,
      }),
    }));
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ connections }) },
      ],
    };
  },
});
