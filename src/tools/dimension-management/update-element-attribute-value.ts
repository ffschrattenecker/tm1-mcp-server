import { z } from "zod";
import { actionResponse } from "../format.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";

// Advertised as a string; a bare number is still accepted and read as text.
// The server coerces to the attribute's type, so callers never have to pick
// between string and number — picking wrong was a recurring malformed call.
const valueSchema = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z.string(),
);

export const registerUpdateElementAttributeValue = defineTool({
  name: "tm1_update_element_attribute_value",
  description: [
    "Set attribute values on elements by writing to the }ElementAttributes_{Dim} control cube.",
    "One value (elementName + attributeName + value) or many in a single write (updates[]). Values are strings, coerced server-side for Numeric attributes.",
    "For reproducible deployments prefer a TI process (AttrPutS / AttrPutN); this REST-direct tool is for ad-hoc / debugging scenarios.",
  ],
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    dimensionName: z.string().describe("Dimension name"),
    elementName: z
      .string()
      .optional()
      .describe("Element whose attribute value should be set"),
    attributeName: z
      .string()
      .optional()
      .describe("Attribute name (must already exist as schema)"),
    value: valueSchema
      .optional()
      .describe(
        "New value as text, e.g. '12.5' for a Numeric attribute. Numeric attributes reject non-numbers.",
      ),
    updates: z
      .array(
        z.object({
          elementName: z.string(),
          attributeName: z.string(),
          value: valueSchema,
        }),
      )
      .min(1)
      .max(5000)
      .optional()
      .describe(
        "Batch form: many {elementName, attributeName, value} in one cellset write. Replaces elementName/attributeName/value.",
      ),
  },
  handler: async (
    { dimensionName, elementName, attributeName, value, updates },
    tm1Client,
  ) => {
    const single =
      elementName !== undefined ||
      attributeName !== undefined ||
      value !== undefined;
    if (updates !== undefined && single) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "Pass either updates[] or elementName/attributeName/value, not both.",
      });
    }
    if (updates !== undefined) {
      await tm1Client.elements.updateAttributeValues(dimensionName, updates);
      return actionResponse({
        success: true,
        dimensionName,
        updated: updates.length,
      });
    }
    if (
      elementName === undefined ||
      attributeName === undefined ||
      value === undefined
    ) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "elementName, attributeName and value are all required (or pass updates[]).",
      });
    }
    await tm1Client.elements.updateAttributeValue(
      dimensionName,
      elementName,
      attributeName,
      value,
    );
    return actionResponse({
      success: true,
      dimensionName,
      elementName,
      attributeName,
      value,
    });
  },
});
