import { z } from "zod";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import {
  actionResponse,
  FORMAT_SCHEMA,
  pageResponse,
  type Column,
} from "../format.js";
import { DESTRUCTIVE, READ_ONLY } from "../annotations.js";
import { JobItemSchema, MutationResultSchema } from "../schemas/items.js";
import { type ToolRegistrar, defineTool } from "../define-tool.js";
import { pageShapeFor } from "../schemas/common.js";

// v12-only: Jobs replace v11 Threads as the "what is running" surface. On a v11
// connection these tools are not registered (thread tools are instead).
const registerListJobs = defineTool({
  name: "tm1_list_jobs",
  description:
    "List active jobs (Activity) on a TM1 v12 database — the running tasks that replaced v11 threads. Paginated (default 50/page). (v12 only)",
  annotations: READ_ONLY,
  enabled: (tm1Client) => tm1Client.version === 12,
  output: pageShapeFor(JobItemSchema),
  input: { ...PAGINATION_SCHEMA, ...FORMAT_SCHEMA },
  handler: async ({ limit, offset, fetchAll, format }, tm1Client) => {
    const jobs = await tm1Client.monitoring.getJobs();
    const page = paginate(jobs, limit, offset, fetchAll);
    type Row = (typeof jobs)[number];
    const columns: Column<Row>[] = [
      { header: "id", get: (j) => j.id },
      { header: "description", get: (j) => j.description },
      { header: "state", get: (j) => j.state },
      { header: "elapsedTime", get: (j) => j.elapsedTime ?? "" },
    ];
    return pageResponse(page, format, { title: "Jobs", columns });
  },
});

const registerCancelJob = defineTool({
  name: "tm1_cancel_job",
  description: [
    "Cancel a running TM1 v12 job by its ID. Use tm1_list_jobs to find the ID.",
    "Non-idempotent: cancelling a finished job errors. Before: tm1_list_jobs to confirm the job is still running.",
    "(v12 only)",
  ],
  annotations: DESTRUCTIVE,
  enabled: (tm1Client) => tm1Client.version === 12,
  output: MutationResultSchema,
  input: {
    jobId: z.string().describe("Job ID to cancel"),
  },
  handler: async ({ jobId }, tm1Client) => {
    await tm1Client.monitoring.cancelJob(jobId);
    return actionResponse({ success: true, jobId });
  },
});

export const registerGetJobs: ToolRegistrar = (server, tm1Client) => {
  registerListJobs(server, tm1Client);
  registerCancelJob(server, tm1Client);
};
