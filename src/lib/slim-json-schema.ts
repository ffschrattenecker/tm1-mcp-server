import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { ZodTypeAny } from "zod";

/**
 * Strip information-free noise from a serialized JSON Schema.
 *
 * Zod's JSON-Schema emitter spells `.int()` out as the JS safe-integer range
 * (`minimum: -9007199254740991` / `maximum: 9007199254740991`) and stamps a
 * `$schema` dialect header onto every root. Both ship on every `tools/list`
 * response and tell a model exactly nothing — together they account for ~25KB
 * across the tool surface. Removing them is lossless: runtime validation still
 * happens against the Zod objects server-side, which are untouched.
 *
 * The strip is deliberately narrow. A `minimum`/`maximum` is dropped ONLY when
 * its value is the exact sentinel, so real bounds (`limit` max 500, `offset`
 * min 0) survive. And keyword rules are suspended inside name-keyed containers
 * (`properties` & friends), where the keys are user-chosen field names — a tool
 * with a field literally called `$schema` keeps its subschema.
 *
 * Descriptions that restate the node's own `default` ("(default: false)",
 * "Default: 50.") lose that phrase: the `default` keyword right next to it
 * already says so. Only a phrase whose value equals the emitted default is
 * removed, so a description documenting a default the schema does not carry
 * (an optional field resolved in the handler) keeps it.
 *
 * Pure: the input is never mutated, the result is a fresh deep clone.
 */

// Zod serializes `.int()` to the JS safe-integer range; these two exact values
// are the sentinel, anything else is a real, author-chosen bound.
const SAFE_INT_MIN = -9007199254740991; // Number.MIN_SAFE_INTEGER
const SAFE_INT_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER

// JSON-Schema containers whose immediate keys are field names, not keywords.
// Recursion must not apply the strip rules one level below these.
const NAME_KEYED_CONTAINERS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove "(default: X)" / "Default: X." where X is the emitted default. */
export function stripDefaultPhrase(
  description: string,
  defaultValue: unknown,
): string {
  if (
    typeof defaultValue !== "boolean" &&
    typeof defaultValue !== "number" &&
    typeof defaultValue !== "string"
  ) {
    return description;
  }
  const value = escapeRegExp(String(defaultValue));
  // Each cut leaves a marker, so the punctuation fix below touches only the
  // spot where a phrase was removed (not other text such as " .json").
  const gap = "\uE000";
  return (
    description
      .replace(new RegExp(String.raw`\s*\(default:?\s*${value}\)`, "gi"), gap)
      .replace(
        new RegExp(
          String.raw`\s*\bDefault:?\s*${value}(?:[.;]|(?=\s)|$)`,
          "gi",
        ),
        gap,
      )
      .replace(new RegExp(`${gap}\\s*([.,;])`, "g"), "$1")
      .replaceAll(gap, "")
      .trim()
      // A phrase that opened the sentence leaves its trailing dash behind.
      .replace(/^[—–-]\s*/, "")
  );
}

export function slimJsonSchema(schema: unknown): unknown {
  return slimNode(schema, false);
}

const SLIM_JSON_CACHE = new WeakMap<
  object,
  Map<string, Record<string, unknown>>
>();

/**
 * Wrap a Zod v4 schema so its StandardJSONSchemaV1 emitter runs once per
 * `(io, target)` and caches the `slimJsonSchema()` output, avoiding repeated
 * Zod→JSON Schema serialization and tree-cloning across `tools/list` calls.
 */
export function withSlimJsonSchema<S extends ZodTypeAny>(
  schema: S,
): StandardSchemaWithJSON<unknown, unknown> {
  const std = (schema as unknown as StandardSchemaWithJSON)["~standard"];
  const jsonConverter = std.jsonSchema;
  let byKey = SLIM_JSON_CACHE.get(schema);
  if (!byKey) {
    byKey = new Map();
    SLIM_JSON_CACHE.set(schema, byKey);
  }
  const cache = byKey;
  const convert = (
    io: "input" | "output",
    options: { target: string },
  ): Record<string, unknown> => {
    const key = `${io}:${options.target}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const raw = jsonConverter[io](
      options as Parameters<typeof jsonConverter.input>[0],
    );
    const slimmed = slimJsonSchema(raw) as Record<string, unknown>;
    cache.set(key, slimmed);
    return slimmed;
  };
  const shape =
    "shape" in schema ? (schema as { shape: unknown }).shape : undefined;
  return {
    ...(shape !== undefined ? { shape } : {}),
    "~standard": {
      version: 1,
      vendor: std.vendor,
      validate: std.validate.bind(std),
      jsonSchema: {
        input: (opts) => convert("input", opts),
        output: (opts) => convert("output", opts),
      },
    },
  };
}

// `nameKeyed` = this node is a map of field-name → subschema, so its own keys
// carry no keyword meaning and must be preserved verbatim.
function slimNode(node: unknown, nameKeyed: boolean): unknown {
  if (Array.isArray(node)) return node.map((entry) => slimNode(entry, false));
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  const defaultValue = nameKeyed
    ? undefined
    : (node as Record<string, unknown>).default;
  for (const [key, value] of Object.entries(node)) {
    if (!nameKeyed) {
      if (key === "$schema") continue;
      if (key === "description" && typeof value === "string") {
        const text = stripDefaultPhrase(value, defaultValue);
        if (text) out[key] = text;
        continue;
      }
      if (key === "minimum" && value === SAFE_INT_MIN) continue;
      if (key === "maximum" && value === SAFE_INT_MAX) continue;
    }
    const slimmed = slimNode(
      value,
      !nameKeyed && NAME_KEYED_CONTAINERS.has(key),
    );
    // A field named `__proto__` would otherwise mutate the prototype chain
    // instead of becoming an own property.
    if (key === "__proto__") {
      Object.defineProperty(out, key, {
        value: slimmed,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }
    out[key] = slimmed;
  }
  return out;
}
