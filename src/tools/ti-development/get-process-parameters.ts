import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  type Column,
} from "../format.js";
import { ProcessParameterSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetProcessParameters = defineTool({
  name: "tm1_get_process_parameters",
  description:
    "Get the parameters of a TurboIntegrator process including names, types and defaults",
  annotations: READ_ONLY,
  output: {
    processName: z.string(),
    parameters: z.array(ProcessParameterSchema),
  },
  input: {
    processName: z.string().describe("Name of the TI process"),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ processName, format }, tm1Client) => {
    const params = await tm1Client.processes.getParameters(processName);
    const payload = { processName, parameters: params };
    type Row = (typeof params)[number];
    const columns: Column<Row>[] = [
      { header: "name", get: (p) => p.name },
      { header: "type", get: (p) => p.type },
      { header: "defaultValue", get: (p) => p.defaultValue },
      { header: "prompt", get: (p) => p.prompt ?? "" },
    ];
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Parameters of ${p.processName}\n\n${renderTable(p.parameters, columns)}`,
    );
  },
});
