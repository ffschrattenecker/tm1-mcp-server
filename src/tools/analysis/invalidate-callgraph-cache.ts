import { defineTool } from "../define-tool.js";
import { READ_ONLY } from "../annotations.js";
import { InvalidateCallgraphCacheResultSchema } from "../schemas/items.js";
import {
  invalidateCallgraphCache,
  getCallgraphCacheStats,
} from "../../lib/callgraph/tm1-adapter.js";

export const registerInvalidateCallgraphCache = defineTool({
  name: "tm1_invalidate_callgraph_cache",
  description:
    "Drop the in-memory ReferenceIndex cache used by tm1_analyze_callgraph / tm1_analyze_object_usage / tm1_analyze_chore_graph. Rarely needed: every successful mutating call through this server already drops it. Use it only after changes made outside this server (Workspace, TI, another client). The next analysis call rebuilds the index (single bulk fetch). Touches no TM1 object, so it is available in readonly mode.",
  annotations: READ_ONLY,
  output: InvalidateCallgraphCacheResultSchema,
  // Takes no arguments: the cache is process-wide.
  input: {},
  handler: () => {
    try {
      const before = getCallgraphCacheStats();
      const { cleared } = invalidateCallgraphCache();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ cleared, entriesBefore: before }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: (error as Error).message ?? String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
