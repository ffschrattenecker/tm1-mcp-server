import type { CallGraphNode, EffectiveValue } from "./callGraph.js";
import { isSecretName, MASK, maskCodeLine } from "../mask-secrets.js";

// Redacts a secret-named entry: its raw text, and its `field` (a call param's
// `resolution` or an effective param's `effective`) when that is a literal.
function maskValueEntries<
  K extends "resolution" | "effective",
  T extends { name: string; valueRaw: string } & Record<K, { kind: string }>,
>(entries: readonly T[], field: K): T[] {
  return entries.map((e) =>
    isSecretName(e.name)
      ? {
          ...e,
          valueRaw: MASK,
          [field]:
            e[field].kind === "literal"
              ? { kind: "literal" as const, value: MASK }
              : e[field],
        }
      : e,
  );
}

function maskEnv(
  env: Map<string, EffectiveValue>,
): Record<string, EffectiveValue> {
  const out: Record<string, EffectiveValue> = {};
  for (const [k, v] of env.entries()) {
    out[k] =
      isSecretName(k) && v.kind === "literal"
        ? { kind: "literal", value: MASK }
        : v;
  }
  return out;
}

export interface SerializeNodeOptions {
  /** Include each node's unresolved calls (analyze_callgraph only). */
  unresolvedCalls?: boolean;
}

/** Full-tree JSON shape for one call graph node; `mask` redacts secrets. */
export function serializeNode(
  node: CallGraphNode,
  mask: boolean,
  options: SerializeNodeOptions = {},
): unknown {
  return {
    process: node.process,
    cycle: node.cycle,
    depthLimitReached: node.depthLimitReached,
    incomingEdge: node.incomingEdge
      ? {
          caller: node.incomingEdge.caller,
          callee: node.incomingEdge.callee,
          section: node.incomingEdge.section,
          line: node.incomingEdge.line,
          funcName: node.incomingEdge.funcName,
          snippet: mask
            ? maskCodeLine(node.incomingEdge.snippet)
            : node.incomingEdge.snippet,
          params: mask
            ? maskValueEntries(node.incomingEdge.params, "resolution")
            : node.incomingEdge.params,
          effectiveParams: node.incomingEdge.effectiveParams
            ? mask
              ? maskValueEntries(node.incomingEdge.effectiveParams, "effective")
              : node.incomingEdge.effectiveParams
            : undefined,
        }
      : null,
    env: node.env
      ? mask
        ? maskEnv(node.env)
        : Object.fromEntries(node.env.entries())
      : undefined,
    ...(options.unresolvedCalls
      ? {
          unresolvedCalls: node.unresolvedCalls
            ? node.unresolvedCalls.map((u) => ({
                section: u.section,
                line: u.line,
                funcName: u.funcName,
                expr: u.expr,
                snippet: mask ? maskCodeLine(u.snippet) : u.snippet,
                reason: u.reason,
              }))
            : undefined,
        }
      : {}),
    children: node.children.map((c) => serializeNode(c, mask, options)),
  };
}
