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
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override the default 30s request timeout (ms, 1000–3600000). A clear that outlasts it keeps running on the server and still empties the cube; the call then reports a timeout instead of success.",
      ),
  },
  handler: async ({ cubeName, confirm, timeoutMs }, tm1Client) => {
    requireConfirm(confirm, cubeName, "cube");
    await tm1Client.cubes.clear(
      cubeName,
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    return actionResponse({ success: true, cubeName, summary: "all cells" });
  },
});
