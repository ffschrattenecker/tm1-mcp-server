import type { CallGraphNode, EffectiveValue } from "./callGraph.js";
import type { CallParam } from "./referenceIndex.js";
import { isSecretName, MASK, maskCodeLine } from "../mask-secrets.js";

function maskParams(params: readonly CallParam[]): CallParam[] {
  return params.map((p) =>
    isSecretName(p.name)
      ? {
          ...p,
          valueRaw: MASK,
          resolution:
            p.resolution.kind === "literal"
              ? { kind: "literal" as const, value: MASK }
              : p.resolution,
        }
      : p,
  );
}

function maskEffective(
  eff: ReadonlyArray<{
    name: string;
    effective: EffectiveValue;
    valueRaw: string;
  }>,
): Array<{ name: string; effective: EffectiveValue; valueRaw: string }> {
  return eff.map((e) =>
    isSecretName(e.name)
      ? {
          ...e,
          valueRaw: MASK,
          effective:
            e.effective.kind === "literal"
              ? { kind: "literal" as const, value: MASK }
              : e.effective,
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
            ? maskParams(node.incomingEdge.params)
            : node.incomingEdge.params,
          effectiveParams: node.incomingEdge.effectiveParams
            ? mask
              ? maskEffective(node.incomingEdge.effectiveParams)
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
