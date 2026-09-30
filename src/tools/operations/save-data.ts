import { z } from "zod";
import { TM1ErrorCode } from "../../types.js";
import { withToolHint } from "../error-format.js";
import { IDEMPOTENT_WRITE, withVersion } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { startHeartbeat } from "../heartbeat.js";

export const registerSaveData = defineTool({
  name: "tm1_save_data",
  description: [
    "Persist in-memory cube data to disk: SaveDataAll (all cubes) or CubeSaveData when `cube` is given.",
    "Run after write sessions (tm1_write_cells, TI loads) — unsaved changes are lost on server crash.",
    "Persists in-memory data to disk only; it does not clear or truncate the transaction log.",
    "v11 only — v12 removed SaveDataAll/CubeSaveData (cloud engine persists automatically).",
    "Executes as an unbound TI process via ExecuteProcessWithReturn; no process object is created on the server.",
  ],
  annotations: withVersion(IDEMPOTENT_WRITE, "v11"),
  version: 11,
  output: MutationResultSchema,
  input: {
    cube: z
      .string()
      .optional()
      .describe(
        "Save only this cube (CubeSaveData). Omit to save all cubes (SaveDataAll).",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Cap on the wait (ms, 1000–3600000; default 3600000). The save is polled, so a SaveDataAll that takes minutes needs no raise. Reaching it stops the waiting, not the save.",
      ),
  },
  handler: async ({ cube, timeoutMs }, tm1Client, extra) => {
    const stopHeartbeat = startHeartbeat(extra, cube ?? "SaveDataAll");
    let result;
    try {
      result = await withToolHint(
        tm1Client.processes.saveData(cube, {
          signal: extra?.signal,
          ...(timeoutMs ? { timeoutMs } : {}),
        }),
        "SaveData failed. On v12 this tool is unsupported (SaveDataAll removed). Check the version with tm1_get_server_state; for a single cube verify the name with tm1_rest_read Cubes('<name>')?$select=Name.",
        // A timed-out or lost-track save is still running — keep that hint.
        [TM1ErrorCode.LOCK_TIMEOUT, TM1ErrorCode.CONNECTION_FAILED],
      );
    } finally {
      stopHeartbeat();
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...result, scope: cube ?? "all" }),
        },
      ],
      // A failed SaveData is a data-persistence failure (in-memory data not
      // written to disk) — surface it as an MCP error, not a success payload
      // carrying success:false, so the caller can't silently miss data loss.
      ...(result.success === false ? { isError: true as const } : {}),
    };
  },
});
