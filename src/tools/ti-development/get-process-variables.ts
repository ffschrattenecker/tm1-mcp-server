import { z } from "zod";
import {
  FORMAT_SCHEMA,
  payloadResponse,
  renderTable,
  columnsOf,
} from "../format.js";
import {
  IgnoredColumnSchema,
  ProcessVariableSchema,
} from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

export const registerGetProcessVariables = defineTool({
  name: "tm1_get_process_variables",
  description:
    "Get the variables (column-name mapping for ASCII/ODBC sources) of a TurboIntegrator process. " +
    "Columns set to 'Ignore' carry no variable and are reported separately in ignoredColumns — " +
    "they are the reason variable positions can have gaps.",
  annotations: READ_ONLY,
  output: {
    processName: z.string(),
    variables: z.array(ProcessVariableSchema),
    ignoredColumns: z.array(IgnoredColumnSchema),
  },
  input: {
    processName: z.string().describe("Name of the TI process"),
    ...FORMAT_SCHEMA,
  },
  handler: async ({ processName, format }, tm1Client) => {
    const { variables, ignoredColumns } =
      await tm1Client.processes.getVariableLayout(processName);
    const payload = { processName, variables, ignoredColumns };
    type Row = (typeof variables)[number];
    const columns = columnsOf<Row>([
      "name",
      "type",
      "position",
      "startByte",
      "endByte",
    ]);
    type IgnoredRow = (typeof ignoredColumns)[number];
    const ignoredCols = columnsOf<IgnoredRow>(["position", "name"]);
    return payloadResponse(
      payload,
      format,
      (p) =>
        `## Variables of ${p.processName}\n\n${renderTable(p.variables, columns)}` +
        (p.ignoredColumns.length > 0
          ? `\n\n### Ignored columns\n\n${renderTable(p.ignoredColumns, ignoredCols)}`
          : ""),
    );
  },
});
