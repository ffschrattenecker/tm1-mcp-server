import { z } from "zod";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerClearCube = defineTool({
  name: "tm1_clear_cube",
  description: [
    "Wipe every cell in a cube. There is no region or slice option — the server offers no selective clear, so this always empties the whole cube.",
    "Prefer TI for reproducible loads — this is for ad-hoc resets. To empty part of a cube, run a TI process with tm1_execute_process instead.",
    "Irreversible: cleared cells return zero/empty on next read. Safety: pass confirm=<cube name verbatim>. Mismatched confirm rejects the call.",
    "Before: tm1_get_cube_stats to see how much data you are about to wipe.",
  ],
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Cube to empty completely"),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ cubeName, confirm }, tm1Client) => {
    requireConfirm(confirm, cubeName, "cube");
    await tm1Client.cubes.clear(cubeName);
    return actionResponse({ success: true, cubeName, summary: "all cells" });
  },
});
