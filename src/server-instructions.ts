import type { ConnectionRegistry } from "./connections.js";

// Sent once per session (MCP `instructions`), so every sentence here is paid
// for by every conversation — keep it to what a model cannot infer from the
// tool list itself.
export function serverInstructions(registry: ConnectionRegistry): string {
  const lines = ["TM1 / IBM Planning Analytics server."];
  if (!registry.isSingle) {
    lines.push(
      "Every tool except tm1_list_connections takes a `connection`; if the target is unclear, call tm1_list_connections and ask. Never write to a connection the user did not name.",
    );
  }
  lines.push(
    "Keep results small: filter by name, use projections (fields, include* flags, compact) and countOnly before paging.",
  );
  return lines.join(" ");
}
