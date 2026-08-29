// Datasource columns that a TI process ignores.
//
// `Process.Variables` lists only the columns that carry a variable. A column
// switched to "Ignore" in the Variables tab drops out of that list entirely:
// its sole trace is `Process.VariablesUIData`, which holds one entry per SOURCE
// COLUMN — ignored ones included — in column order:
//
//   "IgnoredInputVarName=vsSTRN\fVarType=32\fColType=1165\f"   ignored column
//   "VarType=32\fColType=827\f"                                ordinary column
//
// Fields are separated by form feed (0x0C). VarType 32 = String, 33 = Numeric;
// ColType 1165 = Ignore. Measured on 1022 real .pro files (396 ignored columns
// across 30 processes, where the flag lives in line block 582) and live against
// 11.8 and 12.5.
//
// Two consequences drive the code below:
//
//   - `VariablesUIData` is declared in NEITHER version's $metadata, so a plain
//     GET never returns it — it has to be named in `$select` (undeclared is not
//     the same as absent; see the same trap with `Alias`/`Code`).
//   - The raw strings are carried around verbatim rather than rebuilt from a
//     parsed form. Only ColType 1165 is measured; 827 dominates and 830 shows
//     up once in the corpus, so regenerating the array would flatten contents
//     settings whose meaning has not been established.

import type { IgnoredColumn } from "../schemas/processes.js";

/** Field separator inside a VariablesUIData entry (form feed, 0x0C). */
export const UI_DATA_SEPARATOR = "\f";

const IGNORED_COL_TYPE = "1165";

/** One datasource column as the Architect UI records it. */
export interface VariableColumn {
  /** 1-based column position in the datasource. */
  position: number;
  ignored: boolean;
  /** Variable name the column had before it was set to Ignore, if TM1 kept one. */
  ignoredName?: string;
}

function fieldsOf(entry: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of entry.split(UI_DATA_SEPARATOR)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return fields;
}

/**
 * Decode `VariablesUIData` into one entry per datasource column. Returns an
 * empty array when the process has no UI data (nothing was ever ignored, or the
 * server was asked without the `$select`).
 */
export function parseVariableColumns(
  uiData: readonly string[] | undefined,
): VariableColumn[] {
  if (!uiData) return [];
  return uiData.map((entry, idx) => {
    const fields = fieldsOf(entry);
    const ignoredName = fields.get("IgnoredInputVarName");
    const column: VariableColumn = {
      position: idx + 1,
      ignored: fields.get("ColType") === IGNORED_COL_TYPE,
    };
    // TM1 only writes the remembered name on ignored columns, but a column can
    // be ignored without one — treat the flag, not the name, as the signal.
    if (ignoredName !== undefined && ignoredName !== "")
      column.ignoredName = ignoredName;
    return column;
  });
}

/**
 * The ignored columns alone, ready for tool output. `name` is the variable name
 * the column carried before it was ignored; TM1 keeps it so the setting can be
 * undone in Architect.
 */
export function ignoredColumnsOf(
  uiData: readonly string[] | undefined,
): IgnoredColumn[] {
  return parseVariableColumns(uiData)
    .filter((c) => c.ignored)
    .map((c) => ({
      position: c.position,
      ...(c.ignoredName !== undefined ? { name: c.ignoredName } : {}),
    }));
}

/** Stable key for comparing two ignored-column sets (diff tools). */
export function ignoredColumnKey(column: IgnoredColumn): string {
  return `${column.position}:${column.name ?? ""}`;
}
