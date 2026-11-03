import { describe, expect, it } from "vitest";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
// Output schemas come from the defineTool() specs; the barrel import runs them.
import "../../src/tools/index.js";
import { specFor } from "../../src/tools/define-tool.js";
import { asOutputSchema } from "../../src/tools/schemas/output-schema.js";

// Regression guard for the "data must NOT have additional properties" bug.
//
// Several mutation tools return more fields than their MutationResultSchema
// envelope explicitly lists (e.g. processName, parameterCount, updatedTabs).
// MutationResultSchema is declared with `.passthrough()` to allow this, but
// extracting `.shape` discarded the passthrough flag. The SDK then rebuilt
// a strict z.object(), and the published JSON Schema set
// `additionalProperties: false` — causing the client to reject every call.
//
// This test asserts that for tools whose runtime payload includes extras,
// the published JSON Schema must allow additional properties.

// `zod-to-json-schema` ships types built against zod 3, while this project is
// on zod 4 — the two `ZodType` declarations are structurally incompatible even
// though the runtime objects interoperate (that interop is exactly what the
// MCP SDK relies on). Convert at this one seam so the cast is named and
// contained rather than sprinkled over every call site.
type JsonSchemaInput = Parameters<typeof zodToJsonSchema>[0];

function asSchema(entry: ZodRawShape | ZodTypeAny): JsonSchemaInput {
  const schema =
    typeof entry === "object" && entry !== null && "_def" in entry
      ? (entry as ZodTypeAny)
      : z.object(entry);
  return schema as unknown as JsonSchemaInput;
}

const TOOLS_WITH_EXTRAS: string[] = [
  // Mutation envelope (success + per-tool extras)
  "tm1_clear_cube",
  "tm1_update_element_attribute_value",
  "tm1_write_cells",
  // Bespoke schemas that also rely on .passthrough()
  "tm1_upsert_process",
  "tm1_diff_process_with_file",
  "tm1_install_pro_bundle",
  "tm1_check_writable_coords",
  "tm1_analyze_callgraph",
];

describe("output schemas — JSON Schema additionalProperties", () => {
  for (const toolName of TOOLS_WITH_EXTRAS) {
    it(`${toolName}: published JSON Schema permits additional properties`, () => {
      const entry = specFor(toolName)?.outputSchema;
      expect(entry, `missing schema for ${toolName}`).toBeDefined();
      if (entry === undefined) return;
      const schema = asSchema(entry);
      const json = zodToJsonSchema(schema, { strictUnions: true }) as {
        additionalProperties?: boolean | object;
      };
      // additionalProperties may be either `true` or an object schema (both
      // permit extras); only an explicit `false` is the failure mode.
      expect(
        json.additionalProperties,
        `${toolName}: JSON Schema rejects extras (additionalProperties=false). ` +
          `This breaks clients that strictly validate structuredContent.`,
      ).not.toBe(false);
    });
  }
});

// Regression guard for `asOutputSchema`'s passthrough detection.
//
// asOutputSchema decides how to publish a Zod object as an MCP outputSchema:
//   - plain `z.object({...})`  -> return `.shape` (SDK rebuilds a strict
//     object, JSON Schema `additionalProperties: false`).
//   - `.passthrough()` object  -> return the full schema so the SDK preserves
//     `additionalProperties: true` and does not reject per-tool extras.
//
// Detection reads zod 4's `schema.def.catchall`. If a zod point release renamed
// or moved that field, the read would silently return `undefined`, every
// `.passthrough()` schema would be misclassified as plain, and clients would
// start rejecting legitimate extras with "data must NOT have additional
// properties". These tests fail loudly if that happens.

function isRawShape(entry: ZodRawShape | ZodTypeAny): boolean {
  // `.shape` is a plain record with no `_def`; a full schema is a ZodType.
  return !(
    typeof entry === "object" &&
    entry !== null &&
    "_def" in (entry as object)
  );
}

describe("asOutputSchema — passthrough detection", () => {
  it("returns the raw shape for a plain z.object", () => {
    const plain = z.object({ a: z.string(), b: z.number() });
    const result = asOutputSchema(plain);

    // Plain objects publish as ZodRawShape (`.shape`), not the full schema.
    expect(isRawShape(result)).toBe(true);
    expect(result).toBe(plain.shape);
  });

  it("returns the full schema for a .passthrough() object", () => {
    const loose = z.object({ a: z.string() }).passthrough();
    const result = asOutputSchema(loose);

    // Passthrough objects MUST be returned whole so the catchall survives.
    // If catchall detection silently broke (returned undefined), this would
    // instead be the raw shape and the assertion fails.
    expect(isRawShape(result)).toBe(false);
    expect(result).toBe(loose);
  });
});
