import { z } from "zod";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildChoreGraph } from "../../lib/callgraph/choreGraph.js";
import { serializeNode } from "../../lib/callgraph/serialize.js";
import {
  isSecretName,
  MASK,
  resolveMaskSecrets,
} from "../../lib/mask-secrets.js";
import { ChoreGraphResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

function maskChoreParams<T extends Record<string, unknown>>(
  params: readonly T[] | undefined,
): T[] | undefined {
  if (!params) return params;
  return params.map((p) => {
    const name = (p.Name ?? p.name) as string | undefined;
    return name && isSecretName(name) ? { ...p, Value: MASK, value: MASK } : p;
  });
}

export const registerAnalyzeChoreGraph = defineTool({
  name: "tm1_analyze_chore_graph",
  description:
    "Build downstream call graphs for every task of a TM1 chore. Each task's tree is seeded with the chore's task params (literals) which propagate through ExecuteProcess calls. Returns one tree per task plus the chore's own params per task.",
  annotations: READ_ONLY,
  output: ChoreGraphResultSchema,
  input: {
    choreName: z.string().describe("Chore name (case-insensitive)"),
    includeSystem: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include TM1 control objects in the graph. Default: false."),
    includeControl: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Index control objects when building the index. Default: false.",
      ),
    maskSecrets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Redact param values whose name matches /pass|pwd|secret|token|key|credential|auth/i to '***', including chore-task params, edge params, env and snippet.",
      ),
  },
  handler: async (
    {
      choreName,
      includeSystem,
      includeControl,
      maskSecrets: maskSecretsRequested,
    },
    tm1Client,
  ) => {
    // A model-supplied `maskSecrets:false` only takes effect when the
    // operator allowed it via TM1_ALLOW_UNMASKED_SECRETS.
    const maskSecrets = resolveMaskSecrets(maskSecretsRequested);
    const index = await buildIndexFromTM1(tm1Client, { includeControl });
    const graph = buildChoreGraph(index, choreName, { includeSystem });
    if (!graph) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              // Same top-level shape as the success branch so the strict
              // output schema accepts the not-found payload.
              choreName,
              tasks: [],
              warning: `Chore "${choreName}" not found.`,
              indexedChoreCount: index.choreTasks.size,
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              choreName: graph.choreName,
              maskSecrets,
              tasks: graph.tasks.map((t) => ({
                step: t.step,
                processName: t.processName,
                choreParams: maskSecrets
                  ? maskChoreParams(
                      t.choreParams as unknown as Record<string, unknown>[],
                    )
                  : t.choreParams,
                tree: serializeNode(t.tree, maskSecrets),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
