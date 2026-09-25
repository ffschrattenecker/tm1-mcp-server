/**
 * Split a bracketed MDX reference into its parts, `]]` unescaped back to `]`.
 *
 * Hand-parsed rather than matched: a regex over `[^\]]+` cannot see past an
 * escaped `]]`, so every name containing a `]` would fall out of the guard
 * and be written unchecked.
 *
 * Returns null for anything that is not a well-formed bracketed reference —
 * the caller then treats the string as a bare element name, which is what the
 * writer does with it too.
 */
function mdxParts(ref: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  while (i < ref.length) {
    if (ref[i] !== "[") return null;
    i++;
    let name = "";
    for (;;) {
      if (i >= ref.length) return null;
      if (ref[i] === "]") {
        if (ref[i + 1] === "]") {
          name += "]";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      name += ref[i]!;
      i++;
    }
    parts.push(name);
    if (i === ref.length) return parts;
    if (ref[i] !== ".") return null;
    i++;
  }
  return null;
}

/**
 * Where an element reference points, in the four shapes cell-service's
 * `qualifyWriteMember` accepts: a bare name, `[Element]`,
 * `[Dimension].[Element]` (default hierarchy) and the fully qualified
 * `[Dimension].[Hierarchy].[Element]`.
 *
 * Both sides must read a reference the same way. Where this function and the
 * writer disagree, the guard probes one coordinate and the write hits another.
 */
export function memberRef(
  dimension: string,
  element: string,
): { dimension: string; hierarchy: string; element: string } {
  const parts = element.startsWith("[") ? mdxParts(element) : null;
  if (parts?.length === 3) {
    return { dimension: parts[0]!, hierarchy: parts[1]!, element: parts[2]! };
  }
  if (parts?.length === 2) {
    return { dimension: parts[0]!, hierarchy: parts[0]!, element: parts[1]! };
  }
  return {
    dimension,
    hierarchy: dimension,
    element: parts?.length === 1 ? parts[0]! : element,
  };
}
