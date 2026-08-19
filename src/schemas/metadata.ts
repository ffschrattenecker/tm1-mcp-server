// Metadata domain: element statistics and per-element attribute values.
import { z } from "zod";
import { CellValueSchema, ELEMENT_TYPE } from "./common.js";

export const CubeSchema = z.object({
  name: z.string(),
  dimensions: z.array(z.string()),
  hasRules: z.boolean().optional(),
});
export type Cube = z.infer<typeof CubeSchema>;

export const ElementStatsSchema = z.object({
  total: z.number().int(),
  numeric: z.number().int(),
  consolidated: z.number().int(),
  string: z.number().int(),
  maxLevel: z.number().int(),
});
export type ElementStats = z.infer<typeof ElementStatsSchema>;

export const ElementAttributeValueSchema = z.object({
  elementName: z.string(),
  attributeName: z.string(),
  value: CellValueSchema,
});
export type ElementAttributeValue = z.infer<typeof ElementAttributeValueSchema>;

export const DimensionSchema = z.object({
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

export const HierarchyElementSchema = z.object({
  name: z.string(),
  type: ELEMENT_TYPE,
  level: z.number().int(),
  parents: z.array(z.string()),
  children: z.array(z.object({ name: z.string(), weight: z.number() })),
});
export type HierarchyElement = z.infer<typeof HierarchyElementSchema>;

export const HierarchySchema = z.object({
  name: z.string(),
  dimensionName: z.string(),
  elements: z.array(HierarchyElementSchema),
});
export type Hierarchy = z.infer<typeof HierarchySchema>;
