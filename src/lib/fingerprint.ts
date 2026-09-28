// Content fingerprints for the environment compare: two objects are reported
// as differing when their fingerprints differ. Text is normalized exactly as
// the line diff normalizes it, so compare and the drill-down diff agree on
// what "identical" means.
import { createHash } from "node:crypto";
import { normalizeText } from "./line-diff.js";

export function fingerprint(...parts: string[]): string {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(normalizeText(part));
    // Separator so ["ab", "c"] and ["a", "bc"] do not collide.
    hash.update("\u0000");
  }
  return hash.digest("hex");
}
