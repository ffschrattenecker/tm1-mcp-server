// TI process domain: parameter and variable declarations.
import { z } from "zod";
import { PARAM_TYPE } from "./common.js";

export const ProcessParameterSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});
export type ProcessParameter = z.infer<typeof ProcessParameterSchema>;

export const ProcessVariableSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  position: z.number().int(),
  startByte: z.number().int().optional(),
  endByte: z.number().int().optional(),
});
export type ProcessVariable = z.infer<typeof ProcessVariableSchema>;

export const ProcessSchema = z.object({
  name: z.string(),
  parameters: z.array(ProcessParameterSchema),
});
export type Process = z.infer<typeof ProcessSchema>;

export const ProcessCodeSchema = z.object({
  prolog: z.string(),
  metadata: z.string(),
  data: z.string(),
  epilog: z.string(),
});
export type ProcessCode = z.infer<typeof ProcessCodeSchema>;

// TI datasource. Field set measured against 11.8.02900.8 (29 real ODBC
// sources) — `ProcessDataSource` is declared OpenType in $metadata, so the
// server accepts unknown properties and hands them back only sometimes. Two
// fields that were never real (`oDBCConnection`, and `lockType` on the thread
// shape) lived here for months precisely because this shape existed twice.
export const DataSourceSchema = z.object({
  type: z.enum([
    "None",
    "TM1CubeView",
    "TM1DimensionSubset",
    "ASCII",
    "ODBC",
    "TM1Process",
  ]),
  dataSourceNameForServer: z.string().optional(),
  dataSourceNameForClient: z.string().optional(),
  asciiDelimiterType: z.string().optional(),
  asciiDelimiterChar: z.string().optional(),
  asciiQuoteCharacter: z.string().optional(),
  asciiHeaderRecords: z.number().int().optional(),
  asciiDecimalSeparator: z.string().optional(),
  asciiThousandSeparator: z.string().optional(),
  usesUnicode: z.boolean().optional(),
  userName: z.string().optional(),
  password: z.string().optional(),
  query: z.string().optional(),
  view: z.string().optional(),
  subset: z.string().optional(),
});
export type DataSource = z.infer<typeof DataSourceSchema>;
