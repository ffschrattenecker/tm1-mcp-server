import { defineTool } from "../define-tool.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { InvalidateCallgraphCacheResultSchema } from "../schemas/items.js";
import {
  invalidateCallgraphCache,
  getCallgraphCacheStats,
} from "../../lib/callgraph/tm1-adapter.js";

export const registerInvalidateCallgraphCache = defineTool({
  name: "tm1_invalidate_callgraph_cache",
  description:
    "Drop the in-memory ReferenceIndex cache used by tm1_analyze_callgraph / tm1_analyze_object_usage / tm1_analyze_chore_graph. Call this after deploying new processes/rules/chores. The next analysis call will rebuild the index (single bulk fetch).",
  annotations: IDEMPOTENT_WRITE,
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
