import { z } from "zod";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerUnloadCube = defineTool({
  name: "tm1_unload_cube",
  description:
    "Unload a cube from memory. TM1 discards the in-memory fed-cell index and reloads from disk on next access. Required after feeder corrections, since the fed-cell index is cumulative — changes to existing feeders only take effect after an unload. Safe to call: data is preserved (read from .cub on next access). TM1 v11 only.",
  annotations: DESTRUCTIVE,
  // v11 only. v12 answers tm1.Unload with "Demand load, loading and unloading
  // of cubes is no longer supported." — the feature is gone, with no successor
  // endpoint, so the tool is withheld rather than offered and refused.
  enabled: (tm1Client) => tm1Client.version === 11,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Name of the cube to unload"),
  },
  handler: async ({ cubeName }, tm1Client) => {
    await tm1Client.cubes.unload(cubeName);
    return actionResponse({ success: true, cubeName });
  },
});
