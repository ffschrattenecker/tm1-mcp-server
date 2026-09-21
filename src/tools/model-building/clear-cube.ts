import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerClearCube = defineTool({
  name: "tm1_clear_cube",
  description: [
    "Wipe every cell in a cube. There is no region or slice option — the server offers no selective clear, so this always empties the whole cube.",
    "FINAL — treat the data as gone. TM1 has no undo for it, and there is no dependable way back: any SaveDataAll or CubeSaveData that follows writes the empty cube to disk. Cleared cells read as zero/empty.",
    "Prefer TI for reproducible loads — this is for ad-hoc resets. To empty part of a cube, run a TI process with tm1_execute_process instead.",
    "Safety: pass confirm=<cube name verbatim>. Mismatched confirm rejects the call.",
    "Before: tm1_get_cube_stats to see how much data you are about to wipe.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube to empty completely"),
    ...CONFIRM_SCHEMA,
    // Removed in 4.0.0, still DECLARED so a stored old call is refused instead
    // of silently widened: the SDK strips properties the schema does not
    // mention, so an undeclared field reaches the handler as if it was never
    // sent — and a region clear would become a full wipe.
    dimensions: z
      .array(z.string())
      .optional()
      .describe("REMOVED — passing this fails the call. Do not send it."),
    tuples: z
      .array(z.array(z.string()))
      .optional()
      .describe("REMOVED — passing this fails the call. Do not send it."),
  },
  handler: async ({ cubeName, confirm, dimensions, tuples }, tm1Client) => {
    if (dimensions !== undefined || tuples !== undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message:
          "tm1_clear_cube no longer takes `dimensions`/`tuples`, and this call was NOT executed. Sending them once meant a region clear, which the server never supported; ignoring them here would empty the whole cube instead.",
        hint: "To empty the whole cube, repeat the call with cubeName and confirm only. To empty part of it, run a TI process with CubeClearData()/view-based logic via tm1_execute_process.",
      });
    }
    requireConfirm(confirm, cubeName, "cube");
    await tm1Client.cubes.clear(cubeName);
    return actionResponse({ success: true, cubeName, summary: "all cells" });
  },
});
