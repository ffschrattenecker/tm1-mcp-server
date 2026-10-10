import { z } from "zod";
import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../types.js";
import {
  parameterSchema,
  variableSchema,
  dataSourceSchema,
} from "./process-parts-schema.js";

/**
 * tm1-git two-file representation of a TI process.
 *
 * `{name}.json` holds the structure (parameters, variables, datasource,
 * hasSecurityAccess). `{name}.ti` holds the code as TM1's native `Code`
 * representation — `#region <Tab>` / `#endregion` blocks (CRLF, empty tabs
 * omitted), byte-identical to `GET /Processes('x')/Code/$value`. The `.ti`
 * blob is produced by the server, not built here; this module only parses it
 * back (for import preflight). The `.json` is built by serializeProcessToGit.
 *
 * Credentials: the ODBC `password` is never written to the .json. A committed
 * password would be a leaked secret; on import it is re-supplied out of band
 * (see `dataSourcePassword` on the import tool).
 */

export interface GitProcessInput {
  name: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  /**
   * Raw `VariablesUIData` — one entry per datasource column, ignored ones
   * included. Written to the .json as-is because a column set to "Ignore"
   * appears nowhere in `variables`; leaving it out makes the export lose the
   * setting on every re-import.
   */
  variablesUIData?: string[];
  dataSource: DataSource;
  hasSecurityAccess: boolean;
}

export interface GitProcessJson {
  json: string;
  /** True when an ODBC password was present and stripped from the JSON. */
  credentialsOmitted: boolean;
}

export interface ParsedGitProcess {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  variablesUIData?: string[];
  dataSource: DataSource;
  hasSecurityAccess?: boolean;
}

type Tab = "prolog" | "metadata" | "data" | "epilog";

/**
 * Build only the `{name}.json` (structure). Field order mirrors TM1's OData
 * Process entity (Name, HasSecurityAccess, DataSource, then Parameters/
 * Variables); parameter objects follow OData order (Name, Prompt, Value, Type).
 * Order is cosmetic — parseProcessFromGit reads by key.
 */
export function serializeProcessToGit(
  input: GitProcessInput,
  opts?: { includePassword?: boolean },
): GitProcessJson {
  const { password, ...dataSourceNoPwd } = input.dataSource;
  const keepPassword = opts?.includePassword === true && Boolean(password);
  const credentialsOmitted =
    !keepPassword && password !== undefined && password !== "";

  const json =
    JSON.stringify(
      {
        name: input.name,
        hasSecurityAccess: input.hasSecurityAccess,
        dataSource: keepPassword
          ? { ...dataSourceNoPwd, password }
          : dataSourceNoPwd,
        parameters: input.parameters.map((p) => ({
          name: p.name,
          ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
          value: p.defaultValue,
          type: p.type,
        })),
        variables: input.variables,
        ...(input.variablesUIData !== undefined &&
        input.variablesUIData.length > 0
          ? { variablesUIData: input.variablesUIData }
          : {}),
      },
      null,
      2,
    ) + "\n";

  return { json, credentialsOmitted };
}

const TABS: readonly Tab[] = ["prolog", "metadata", "data", "epilog"];

/** Build a descriptive error naming the structural problem ("reject, don't guess"). */
function regionBlobError(problem: string): Error {
  return new Error(
    `TI file has a malformed #region/#endregion code blob: ${problem} ` +
      "Refusing to parse a structurally invalid blob (this would otherwise silently drop or " +
      "misattribute code). Re-export from the server, or fix the marker manually.",
  );
}

/** The tab a line opens (`#region Prolog`, case-insensitive), or undefined. */
function openedTab(line: string): Tab | undefined {
  const m = /^[ \t]*#region[ \t]+(\w+)[ \t]*$/i.exec(line);
  const name = m?.[1]!.toLowerCase();
  return TABS.includes(name as Tab) ? (name as Tab) : undefined;
}

/** The server's tab close: a bare `#endregion` (lowercase, as TM1 writes it). */
function isTabClose(line: string): boolean {
  return /^[ \t]*#endregion[ \t]*$/.test(line);
}

/**
 * Parse a native `#region <Tab>` / `#endregion` code blob into the four tabs.
 * Tabs come in fixed order; a tab whose region is absent defaults to "".
 *
 * Users write their OWN `#Region` / `#EndRegion` folds into the code (PAW/Arc
 * support it) and the server stores them inside the tab. They are code, never
 * structure — and they can be wrong: on an 11.8 server 94 of 366 processes
 * carry folds and 2 leave one open, so counting depth rejected real exports.
 * A tab therefore ends at the bare `#endregion` that is followed (blank lines
 * aside) by the opening of a LATER tab or by the end of the blob — the shape
 * the server writes. Any other `#endregion` stays in the tab's code. The same
 * rule reads the file in the VS Code extension (git/sectionMarkers.ts).
 *
 * Still throws on genuine structural corruption: no tab at all (rejects the
 * pre-1.x `### TM1-TI-TAB:` layout), code or an unknown `#region` outside a
 * tab, tabs out of order or twice, a later tab opening inside a tab (its
 * `#endregion` was deleted — reading on would swallow that tab), or a tab
 * that never closes.
 */
function parseCodeBlob(ti: string): Record<Tab, string> {
  const out: Record<Tab, string> = {
    prolog: "",
    metadata: "",
    data: "",
    epilog: "",
  };
  // Lines with their own ending, so tab content is sliced from the raw text.
  const lines = ti.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const text = (k: number) => lines[k]!.replace(/\r?\n$/, "");
  const offsets: number[] = [];
  lines.reduce((at, l) => (offsets.push(at), at + l.length), 0);
  offsets.push(ti.length);
  const nextNonBlank = (from: number) => {
    let k = from;
    while (k < lines.length && text(k).trim() === "") k++;
    return k;
  };

  if (!/^[ \t]*#region\b/im.test(ti)) {
    throw new Error(
      "TI file has no #region markers (expected `#region Prolog` … `#endregion`). " +
        "Pre-1.x `### TM1-TI-TAB:` files are no longer supported — re-export from the server.",
    );
  }

  let last = -1;
  let i = nextNonBlank(0);
  while (i < lines.length) {
    const tab = openedTab(text(i));
    if (!tab) {
      throw regionBlobError(
        `found ${JSON.stringify(text(i).trim().slice(0, 40))} outside a tab ` +
          "(expected `#region Prolog`/`Metadata`/`Data`/`Epilog`).",
      );
    }
    if (TABS.indexOf(tab) <= last) {
      throw regionBlobError(
        `tab "${tab}" appears twice or out of order (expected Prolog, Metadata, Data, Epilog).`,
      );
    }
    let j = i + 1;
    for (; ; j++) {
      if (j >= lines.length) {
        throw regionBlobError(
          `"#region ${tab}" is missing its matching #endregion — the blob is truncated ` +
            "or a closing #endregion is missing.",
        );
      }
      const inner = openedTab(text(j));
      if (inner && TABS.indexOf(inner) > TABS.indexOf(tab)) {
        throw regionBlobError(
          `"#region ${inner}" opens inside "${tab}" — the #endregion closing "${tab}" is missing.`,
        );
      }
      if (!isTabClose(text(j))) continue;
      const k = nextNonBlank(j + 1);
      const following = k < lines.length ? openedTab(text(k)) : undefined;
      if (k === lines.length || following) break;
    }
    // Strip the single line break the server places before #endregion.
    out[tab] = ti.slice(offsets[i + 1], offsets[j]).replace(/\r?\n$/, "");
    last = TABS.indexOf(tab);
    i = nextNonBlank(j + 1);
  }
  return out;
}

const KNOWN_JSON_KEYS: ReadonlySet<string> = new Set([
  "name",
  "hasSecurityAccess",
  "parameters",
  "variables",
  "variablesUIData",
  "dataSource",
]);
const REQUIRED_JSON_KEYS = ["parameters", "variables", "dataSource"] as const;

/**
 * Import deploys the .json as the whole truth: a missing `parameters` or
 * `variables` goes out as an empty list, a missing `dataSource` as `None`, and
 * TM1 applies both. A .json in another layout (e.g. PascalCase `Parameters`
 * as written by the VS Code extension) therefore parsed to "no parameters, no
 * variables, no source" and wiped them on the server without a word. Reject
 * any unknown key and any missing structural key instead of guessing.
 */
function assertKnownJsonShape(meta: unknown): void {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Process JSON must be an object");
  }
  const keys = Object.keys(meta);
  const unknown = keys.filter((k) => !KNOWN_JSON_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Process JSON has unknown key(s): ${unknown.join(", ")}. ` +
        `Expected only: ${[...KNOWN_JSON_KEYS].join(", ")}. ` +
        "Refusing to deploy: unread fields would be sent as empty and clear the process on the server.",
    );
  }
  const missing = REQUIRED_JSON_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new Error(
      `Process JSON is missing key(s): ${missing.join(", ")}. ` +
        "Refusing to deploy: a missing list would be sent as empty and clear it on the server.",
    );
  }
}

/** Parse a `{name}.json` + `{name}.ti` pair back into deployable process parts. */
export function parseProcessFromGit(
  jsonContent: string,
  tiContent: string,
): ParsedGitProcess {
  let meta: {
    name?: unknown;
    hasSecurityAccess?: unknown;
    parameters?: unknown;
    variables?: unknown;
    variablesUIData?: unknown;
    dataSource?: unknown;
  };
  try {
    meta = JSON.parse(jsonContent) as typeof meta;
  } catch {
    throw new Error("Process JSON is not valid JSON");
  }
  assertKnownJsonShape(meta);

  const name = typeof meta.name === "string" ? meta.name : "";
  const hasSecurityAccess =
    typeof meta.hasSecurityAccess === "boolean"
      ? meta.hasSecurityAccess
      : undefined;

  // Git .json uses the OData-native param field name `value`; the internal
  // schema uses `defaultValue`. Normalize value→defaultValue before validation,
  // keeping back-compat with legacy files that wrote `defaultValue`.
  const rawParams = Array.isArray(meta.parameters)
    ? (meta.parameters as unknown[]).map((p): unknown => {
        if (
          p &&
          typeof p === "object" &&
          "value" in p &&
          !("defaultValue" in p)
        ) {
          const { value, ...rest } = p as Record<string, unknown>;
          return { ...rest, defaultValue: value };
        }
        return p;
      })
    : (meta.parameters ?? []);

  const paramsResult = z.array(parameterSchema).safeParse(rawParams);
  if (!paramsResult.success) {
    throw new Error(
      `Process JSON has invalid 'parameters': ${paramsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const parameters: ProcessParameter[] = paramsResult.data;

  const varsResult = z.array(variableSchema).safeParse(meta.variables ?? []);
  if (!varsResult.success) {
    throw new Error(
      `Process JSON has invalid 'variables': ${varsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const variables: ProcessVariable[] = varsResult.data;

  const uiResult = z.array(z.string()).safeParse(meta.variablesUIData ?? []);
  if (!uiResult.success) {
    throw new Error(
      `Process JSON has invalid 'variablesUIData': ${uiResult.error.issues[0]?.message ?? "expected an array of strings"}`,
    );
  }
  const variablesUIData: string[] = uiResult.data;

  const dsResult = dataSourceSchema.safeParse(
    meta.dataSource ?? { type: "None" },
  );
  if (!dsResult.success) {
    throw new Error(
      `Process JSON has invalid 'dataSource': ${dsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const dataSource: DataSource = dsResult.data;

  const tabs = parseCodeBlob(tiContent);

  return {
    name,
    ...(hasSecurityAccess !== undefined ? { hasSecurityAccess } : {}),
    prolog: tabs.prolog,
    metadata: tabs.metadata,
    data: tabs.data,
    epilog: tabs.epilog,
    parameters,
    variables,
    ...(variablesUIData.length > 0 ? { variablesUIData } : {}),
    dataSource,
  };
}
