import { z } from "zod";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";
import { DataSourceSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetProcessDatasource = defineTool({
  name: "tm1_get_process_datasource",
  description:
    "Get the data source configuration of a TurboIntegrator process. The password field is always redacted.",
  annotations: READ_ONLY,
  output: DataSourceSchema,
  input: {
    processName: z.string().describe("Name of the TI process"),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ processName, format }, tm1Client) => {
    const ds = await tm1Client.processes.getDataSource(processName);
    return payloadResponse(ds, format, (d) =>
      renderKV(
        d as unknown as Record<string, unknown>,
        `Datasource of ${processName}`,
      ),
    );
  },
});
