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
