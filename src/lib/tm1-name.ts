/**
 * TM1 name identity: the server treats `Total Year`, `totalyear` and
 * `TOTAL YEAR` as the same object (case- and space-insensitive), so any
 * client-side lookup against server names must key on this, not on
 * `toLowerCase()` alone. Mirrors tm1py's `lower_and_drop_spaces`.
 */
export const tm1NameKey = (name: string): string =>
  name.toLowerCase().replace(/ /g, "");

export const tm1NameEquals = (a: string, b: string): boolean =>
  tm1NameKey(a) === tm1NameKey(b);

/**
 * A cube's dimensions without the leading `Sandboxes` dimension that
 * EnableSandboxDimension adds to every cube, so cubes compare equal across
 * servers with the setting on and off.
 */
export const withoutSandboxes = (dims: readonly string[]): string[] =>
  dims.length > 0 && tm1NameEquals(dims[0]!, "Sandboxes")
    ? dims.slice(1)
    : [...dims];
