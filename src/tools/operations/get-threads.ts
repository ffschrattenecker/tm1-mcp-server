import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import {
  actionResponse,
  FORMAT_SCHEMA,
  pageResponse,
  columnsOf,
} from "../format.js";
import { DESTRUCTIVE, READ_ONLY } from "../annotations.js";
import { MutationResultSchema, ThreadSchema } from "../schemas/items.js";
import { type ToolRegistrar, defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

const registerListThreads = defineTool({
  name: "tm1_list_threads",
  description:
    "List active threads on the TM1 server (running processes, chores, MDX queries, etc.). Paginated (default 50/page). (v11 only)",
  annotations: READ_ONLY,
  enabled: (tm1Client) => tm1Client.version === 11,
  output: pageShapeFor(ThreadSchema),
  input: { ...PAGINATION_SCHEMA, ...FORMAT_SCHEMA },
  handler: async ({ limit, offset, fetchAll, format }, tm1Client) => {
    const threads = await tm1Client.monitoring.getThreads();
    const page = paginate(threads, limit, offset, fetchAll);
    type Row = (typeof threads)[number];
    const columns = columnsOf<Row>([
      "id",
      "name",
      "state",
      "function",
      "objectName",
    ]);
    return pageResponse(page, format, { title: "Threads", columns });
  },
});

const registerCancelThread = defineTool({
  name: "tm1_cancel_thread",
  description: [
    "Cancel a running TM1 server thread by its ID. Use tm1_list_threads to find the ID.",
    "Non-idempotent: cancelling a finished thread errors. Before: tm1_list_threads to confirm the thread is still running.",
    "(v11 only)",
  ],
  annotations: DESTRUCTIVE,
  enabled: (tm1Client) => tm1Client.version === 11,
  output: MutationResultSchema,
  input: {
    id: z.number().int().describe("Thread ID to cancel"),
  },
  handler: async ({ id }, tm1Client) => {
    await tm1Client.monitoring.cancelThread(id);
    return actionResponse({ success: true, threadId: id });
  },
});

export const registerGetThreads: ToolRegistrar = (server, tm1Client) => {
  registerListThreads(server, tm1Client);
  registerCancelThread(server, tm1Client);
};
