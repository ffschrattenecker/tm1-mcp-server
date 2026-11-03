// Metadata domain: element statistics and per-element attribute values.
import { z } from "zod";
import { ELEMENT_TYPE } from "./common.js";

const CubeSchema = z.object({
  name: z.string(),
  dimensions: z.array(z.string()),
  hasRules: z.boolean().optional(),
});
export type Cube = z.infer<typeof CubeSchema>;

const DimensionSchema = z.object({
  name: z.string(),
  hierarchies: z.array(z.string()),
  // Populated only when getDimensions({includeElementCount: true}) is called.
  // Map hierarchyName → element total.
  elementCounts: z.record(z.string(), z.number().int()).optional(),
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
