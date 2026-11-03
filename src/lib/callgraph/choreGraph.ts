import type { ReferenceIndex, ChoreTaskRef } from "./referenceIndex.js";
import type { CallGraphNode } from "./callGraph.js";
import { buildCallGraph } from "./callGraph.js";

interface ChoreTaskTree {
  step: number;
  processName: string;
  choreParams: ChoreTaskRef["params"];
  tree: CallGraphNode;
}

export interface ChoreGraph {
  choreName: string;
  tasks: ChoreTaskTree[];
}

export interface BuildChoreGraphOptions {
  /** Mirrors the call-graph option — filters }-prefixed sub-processes. Default: true. */
  includeSystem?: boolean;
}

/**
 * Build one downstream tree per chore task. Task params are seeded into the
 * task-process's root env as literals before the tree is built.
 * Returns null if the chore is not indexed.
 */
export function buildChoreGraph(
  index: ReferenceIndex,
  choreName: string,
  opts: BuildChoreGraphOptions = {},
): ChoreGraph | null {
  const tasks = index.choreTasks.get(choreName.toLowerCase());
  if (!tasks) {
    return null;
  }

  const includeSystem = opts.includeSystem ?? true;

  const taskTrees: ChoreTaskTree[] = tasks.map((t) => ({
    step: t.step,
    processName: t.processName,
    choreParams: t.params,
    tree: buildCallGraph(index, t.processName, {
      direction: "downstream",
      includeSystem,
      rootParams: t.params,
    }),
  }));

  return { choreName, tasks: taskTrees };
}
