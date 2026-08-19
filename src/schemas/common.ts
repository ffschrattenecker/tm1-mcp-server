// Shared primitives for the domain schemas.
//
// These live below both consumers on purpose: `src/tm1-client/` (which parses
// them off the wire) and `src/tools/` (which publishes them as outputSchema)
// import from here, never from each other. Nothing in this directory may import
// from `../tools/` or `../types.js`.
import { z } from "zod";

/** A TM1 cell: text, number, or empty. */
export const CellValueSchema = z.union([z.string(), z.number(), z.null()]);
export type CellValue = z.infer<typeof CellValueSchema>;

/** Element type as the OData surface spells it. */
export const ELEMENT_TYPE = z.enum(["Numeric", "String", "Consolidated"]);

/** TI parameter/variable type as the OData surface spells it. */
export const PARAM_TYPE = z.enum(["String", "Numeric"]);
