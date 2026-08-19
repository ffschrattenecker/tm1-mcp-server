import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  type Column,
} from "../format.js";
import { ProcessVariableSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetProcessVariables = defineTool({
  name: "tm1_get_process_variables",
  description:
    "Get the variables (column-name mapping for ASCII/ODBC sources) of a TurboIntegrator process",
  annotations: READ_ONLY,
  output: {
    processName: z.string(),
    variables: z.array(ProcessVariableSchema),
  },
  input: {
    processName: z.string().describe("Name of the TI process"),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ processName, format }, tm1Client) => {
    const variables = await tm1Client.processes.getVariables(processName);
    const payload = { processName, variables };
    type Row = (typeof variables)[number];
    const columns: Column<Row>[] = [
      { header: "name", get: (v) => v.name },
      { header: "type", get: (v) => v.type },
      { header: "position", get: (v) => v.position },
      { header: "startByte", get: (v) => v.startByte ?? "" },
      { header: "endByte", get: (v) => v.endByte ?? "" },
    ];
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Variables of ${p.processName}\n\n${renderTable(p.variables, columns)}`,
    );
  },
});
