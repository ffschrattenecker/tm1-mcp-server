// What deleting a cube or dimension would break, for the delete tools' dryRun.
// The same index and per-source rows as tm1_analyze_object_usage mode=summary,
// plus the cubes a dimension is part of (TM1 refuses deleting those anyway).
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildCubeOrDimUsages } from "../../lib/callgraph/callGraph.js";
import {
  cubesUsingDimension,
  summarizeBySource,
} from "./analyze-object-usage.js";

const MAX_SOURCES = 50;

export async function deleteImpact(
  tm1Client: TM1Client,
  kind: "cube" | "dimension",
  name: string,
) {
  // includeSystem=true keeps the control cubes (}ElementAttributes_X) this
  // list has always shown.
  const [index, usedInCubes] = await Promise.all([
    buildIndexFromTM1(tm1Client, { includeControl: false }),
    kind === "dimension"
      ? cubesUsingDimension(tm1Client, name, true)
      : Promise.resolve([]),
  ]);
  const sources = summarizeBySource(
    buildCubeOrDimUsages(index, kind, name, {
      includeSystem: false,
      accessMode: "all",
    }),
  );
  return {
    ...(kind === "dimension" ? { usedInCubes } : {}),
    referencingSources: sources.length,
    ...(sources.length > MAX_SOURCES ? { truncated: true } : {}),
    sources: sources.slice(0, MAX_SOURCES).map((s) => ({
      sourceKind: s.sourceKind,
      sourceName: s.sourceName,
      accessTypes: s.accessTypes,
      count: s.count,
    })),
  };
}
