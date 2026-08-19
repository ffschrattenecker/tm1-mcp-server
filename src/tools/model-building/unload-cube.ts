import { z } from "zod";
import { actionResponse } from "../format.js";
import { DESTRUCTIVE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";

export const registerUnloadCube = defineTool({
  name: "tm1_unload_cube",
  description:
    "Unload a cube from memory. TM1 discards the in-memory fed-cell index and reloads from disk on next access. Required after feeder corrections, since the fed-cell index is cumulative — changes to existing feeders only take effect after an unload. Safe to call: data is preserved (read from .cub on next access).",
  annotations: DESTRUCTIVE,
  output: MutationResultSchema,
  input: {
    cubeName: z.string().describe("Name of the cube to unload"),
  },
  handler: async ({ cubeName }, tm1Client) => {
    await tm1Client.cubes.unload(cubeName);
    return actionResponse({ success: true, cubeName });
  },
});
