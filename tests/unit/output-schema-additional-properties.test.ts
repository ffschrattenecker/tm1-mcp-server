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

// Mirror how the MCP SDK publishes an outputSchema: for a ZodRawShape it wraps
// in `z.object(shape)`, for a full schema it uses it as-is, then converts with
// zod 4's native `z.toJSONSchema`. The SDK passes `pipeStrategy: "output"` for
// outputSchema conversion (see mcp.js), which maps to `io: "output"` — so we
// reproduce that here to get the exact JSON Schema clients receive.
function publishedJsonSchema(entry: ZodRawShape | ZodTypeAny): {
  additionalProperties?: boolean | object;
} {
  const schema =
    typeof entry === "object" && entry !== null && "_def" in (entry as object)
      ? (entry as ZodTypeAny)
      : z.object(entry as ZodRawShape);
  return z.toJSONSchema(schema, { io: "output" });
}

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

  it("published JSON Schema has additionalProperties:false for plain objects", () => {
    const plain = z.object({ a: z.string() });
    const json = publishedJsonSchema(asOutputSchema(plain));
    expect(json.additionalProperties).toBe(false);
  });

  it("published JSON Schema permits extras for .passthrough() objects", () => {
    const loose = z.object({ a: z.string() }).passthrough();
    const json = publishedJsonSchema(asOutputSchema(loose));
    // A permissive object (`{}`) or `true` both allow extras; only an explicit
    // `false` is the failure mode that breaks clients validating extras.
    expect(json.additionalProperties).not.toBe(false);
    expect(json.additionalProperties).not.toBeUndefined();
  });

  it("catchall field exists on passthrough and is absent on plain (zod-shape guard)", () => {
    // Directly assert the internal contract asOutputSchema depends on, so a
    // zod release that moves `def.catchall` trips this test explicitly.
    const plain = z.object({ a: z.string() });
    const loose = z.object({ a: z.string() }).passthrough();
    expect(plain.def.catchall).toBeUndefined();
    expect(loose.def.catchall).not.toBeUndefined();
  });
});
