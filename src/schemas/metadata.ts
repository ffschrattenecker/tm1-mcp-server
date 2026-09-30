// Metadata domain: element statistics and per-element attribute values.
import { z } from "zod";
import { ELEMENT_TYPE } from "./common.js";

const CubeSchema = z.object({
  name: z.string(),
  dimensions: z.array(z.string()),
  hasRules: z.boolean().optional(),
});
export type Cube = z.infer<typeof CubeSchema>;

const ElementStatsSchema = z.object({
  total: z.number().int(),
  numeric: z.number().int(),
  consolidated: z.number().int(),
  string: z.number().int(),
  maxLevel: z.number().int(),
});

const DimensionSchema = z.object({
  name: z.string(),
  hierarchies: z.array(z.string()),
  // Populated only when getDimensions({includeElementCount: true}) is called.
  // Map hierarchyName → element total.
  elementCounts: z.record(z.string(), z.number().int()).optional(),
  // Populated only when getDimensions({includeElementStats: true}) is called.
  // Map hierarchyName → Type breakdown (N/C/S) + maxLevel.
  elementStats: z.record(z.string(), ElementStatsSchema).optional(),
  // Populated only when includeLastUpdated is asked for. Naive-local ISO
  // (no Z) decoded from }DimensionProperties.LAST_TIME_UPDATED — a
  // schema-change stamp. null when the dimension has no stamp.
  lastUpdated: z.string().nullable().optional(),
});
export type Dimension = z.infer<typeof DimensionSchema>;

const HierarchyElementSchema = z.object({
  name: z.string(),
  type: ELEMENT_TYPE,
  level: z.number().int(),
  parents: z.array(z.string()),
  children: z.array(z.object({ name: z.string(), weight: z.number() })),
});
export type HierarchyElement = z.infer<typeof HierarchyElementSchema>;
