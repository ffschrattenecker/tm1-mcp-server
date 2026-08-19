// The resolved per-tool metadata view — one lookup that answers "what does the
// SDK get registered with for this tool", regardless of where the tool declared
// it.
//
// Two declaration sites exist while the defineTool migration runs:
//   - a `defineTool({...})` spec, which owns its annotation and outputSchema
//   - the legacy name-keyed ANNOTATION_MAP / OUTPUT_SCHEMA_MAP entries
// The spec wins where both exist; the lint gates fail a leftover map entry for
// a migrated tool, so that overlap is a transient state, not a supported one.
//
// Everything that reasons about the full tool surface — the registration Proxy,
// the unit tests, scripts/check-output-schema-budget.mjs — reads THIS module,
// so migrating a tool never means teaching another consumer about specs.
//
// Note on completeness: spec entries only exist once the tool module has been
// imported (a top-level defineTool() call registers them). Callers wanting the
// whole surface must import ./index.js first — as registerAllTools() and the
// tests do.
import type { ZodRawShape, ZodTypeAny } from "zod";
import type { Tm1ToolAnnotations } from "./annotations.js";
import { ANNOTATION_MAP } from "./annotation-map.js";
import { OUTPUT_SCHEMA_MAP } from "./output-schema-map.js";
import { allSpecs } from "./define-tool.js";

export interface ToolMetadata {
  annotations: Tm1ToolAnnotations;
  /** Absent for tools that answer with unstructured text. */
  outputSchema?: ZodRawShape | ZodTypeAny;
}

export function toolMetadata(name: string): ToolMetadata | undefined {
  const spec = allSpecs().get(name);
  if (spec) {
    return spec.outputSchema === undefined
      ? { annotations: spec.annotations }
      : { annotations: spec.annotations, outputSchema: spec.outputSchema };
  }
  const annotations = ANNOTATION_MAP[name];
  if (!annotations) return undefined;
  const outputSchema = OUTPUT_SCHEMA_MAP[name];
  return outputSchema === undefined
    ? { annotations }
    : { annotations, outputSchema };
}

/** Every tool whose metadata is known, spec-declared and map-declared alike. */
export function allToolMetadata(): Map<string, ToolMetadata> {
  const merged = new Map<string, ToolMetadata>();
  for (const name of Object.keys(ANNOTATION_MAP)) {
    const meta = toolMetadata(name);
    if (meta) merged.set(name, meta);
  }
  for (const name of allSpecs().keys()) {
    const meta = toolMetadata(name);
    if (meta) merged.set(name, meta);
  }
  return merged;
}
