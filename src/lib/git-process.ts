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
 * `{name}.json` is the server's own REST payload for the process minus the code:
 * the response to `$select=Name,HasSecurityAccess,UIData,VariablesUIData,
 * DataSource,Parameters,Variables` without `@odata.*`, in the server's key order,
 * 2-space indent and a trailing newline. No renamed or invented fields, so any
 * tool that reads TM1 REST reads the file, and the VS Code extension writes the
 * same bytes (366 of 366 processes measured on 11.8). `UIData` and
 * `VariablesUIData` are undeclared in $metadata and missing from a plain GET,
 * but needed: the first holds the Architect action settings (a POST does not
 * create it), the second every datasource column including ignored ones.
 *
 * `{name}.ti` holds the code as TM1's native `Code` representation —
 * `#region <Tab>` / `#endregion` blocks (CRLF, empty tabs omitted),
 * byte-identical to `GET /Processes('x')/Code/$value`. The `.ti` blob is
 * produced by the server, not built here; this module only parses it back.
 *
 * Credentials: the ODBC `password` is never written to the .json. A committed
 * password would be a leaked secret; on import it is re-supplied out of band
 * (see `dataSourcePassword` on the import tool).
 */

/** The process as TM1 REST returns it for the .json field list. */
export interface NativeProcessHeader {
  Name: string;
  HasSecurityAccess?: boolean;
  UIData?: string;
  VariablesUIData?: string[];
  DataSource: { Type: string; password?: string; [key: string]: unknown };
  Parameters: Array<{
    Name: string;
    Prompt?: string;
    Value: string | number;
    Type: string;
  }>;
  Variables: Array<{
    Name: string;
    Type: string;
    Position: number;
    StartByte?: number;
    EndByte?: number;
  }>;
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
  /** Architect action settings; absent in files written before 2026-10-10. */
  uiData?: string;
  dataSource: DataSource;
  hasSecurityAccess?: boolean;
}

type Tab = "prolog" | "metadata" | "data" | "epilog";

/**
 * Build the `{name}.json`: the server payload as it came, the password
 * stripped unless asked for. Key order is the server's, so nothing is rebuilt.
 */
export function serializeProcessToGit(
  header: NativeProcessHeader,
  opts?: { includePassword?: boolean },
): GitProcessJson {
  const { password, ...dataSourceNoPwd } = header.DataSource;
  const keepPassword = opts?.includePassword === true && Boolean(password);
  const credentialsOmitted =
    !keepPassword && password !== undefined && password !== "";
  const json =
    JSON.stringify(
      {
        ...header,
        DataSource: keepPassword
          ? { ...dataSourceNoPwd, password }
          : dataSourceNoPwd,
      },
      null,
      2,
    ) + "\n";
  return { json, credentialsOmitted };
}

const TABS: readonly Tab[] = ["prolog", "metadata", "data", "epilog"];

/**
 * The `.ti` for a process without code. TM1 (11.8 and 12) sends an empty
 * `Code` blob there, but the parser rejects an empty file — a truncated `.ti`
 * must not deploy as "delete all code". So the export writes one empty Prolog
 * region instead, the same bytes the VS Code extension writes.
 */
export const EMPTY_CODE_BLOB = "#region Prolog\r\n#endregion";

/** Build a descriptive error naming the structural problem ("reject, don't guess"). */
function regionBlobError(problem: string): Error {
  return new Error(
    `TI file has a malformed #region/#endregion code blob: ${problem} ` +
      "Refusing to parse a structurally invalid blob (this would otherwise silently drop or " +
      "misattribute code). Re-export from the server, or fix the marker manually.",
  );
}

/**
 * The tab a line opens, or undefined. The keyword is lowercase, as TM1 writes
 * it: a user fold `#Region Data` stays code (VS Code extension, same rule).
 */
function openedTab(line: string): Tab | undefined {
  const m = /^[ \t]*#region[ \t]+(\w+)[ \t]*$/.exec(line);
  const name = m?.[1]!.toLowerCase();
  return TABS.includes(name as Tab) ? (name as Tab) : undefined;
}

/**
 * The server's tab close: a bare `#endregion` (lowercase, as TM1 writes it).
 * Also the VS Code extension's former `#endregion prolog` close, so `.ti`
 * files it wrote before 2026-10-10 still read (git/sectionMarkers.ts).
 */
function isTabClose(line: string): boolean {
  return /^[ \t]*#endregion(?: (?:prolog|metadata|data|epilog))?[ \t]*$/.test(
    line,
  );
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

const NATIVE_KEYS = [
  "Name",
  "HasSecurityAccess",
  "UIData",
  "VariablesUIData",
  "DataSource",
  "Parameters",
  "Variables",
] as const;
const LEGACY_KEYS = [
  "name",
  "hasSecurityAccess",
  "parameters",
  "variables",
  "variablesUIData",
  "dataSource",
] as const;
const DATASOURCE_KEYS = new Set(Object.keys(dataSourceSchema.shape));

/**
 * Import deploys the .json as the whole truth: a missing parameter or variable
 * list goes out empty, a missing data source as `None`, and TM1 applies both.
 * A file whose keys were not read (another layout, a typo) therefore cleared
 * them on the server without a word. Accept exactly one of the two layouts —
 * the native REST one, or the lowercase one written before 2026-10-10 — and
 * require the three structural keys; reject anything else instead of guessing.
 */
function assertKnownJsonShape(meta: unknown): "native" | "legacy" {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Process JSON must be an object");
  }
  const keys = Object.keys(meta);
  const layout = keys.some((k) => /^[A-Z]/.test(k)) ? "native" : "legacy";
  const known: readonly string[] =
    layout === "native" ? NATIVE_KEYS : LEGACY_KEYS;
  const unknown = keys.filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `Process JSON has unknown key(s): ${unknown.join(", ")}. ` +
        `Expected only: ${known.join(", ")}. ` +
        "Refusing to deploy: unread fields would be sent as empty and clear the process on the server.",
    );
  }
  const required =
    layout === "native"
      ? ["Parameters", "Variables", "DataSource"]
      : ["parameters", "variables", "dataSource"];
  const missing = required.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new Error(
      `Process JSON is missing key(s): ${missing.join(", ")}. ` +
        "Refusing to deploy: a missing list would be sent as empty and clear it on the server.",
    );
  }
  return layout;
}

/** Native REST field names → the lowercase shape the validators below read. */
function fromNative(n: Record<string, unknown>): Record<string, unknown> {
  // Non-list values pass through untouched, so the validators name them.
  const rows = (
    v: unknown,
    map: (r: Record<string, unknown>) => unknown,
  ): unknown =>
    Array.isArray(v)
      ? (v as unknown[]).map((r): unknown =>
          r && typeof r === "object" ? map(r as Record<string, unknown>) : r,
        )
      : v;
  const ds = n.DataSource as Record<string, unknown> | undefined;
  const { Type, ...dsRest } = ds && typeof ds === "object" ? ds : {};
  return {
    name: n.Name,
    hasSecurityAccess: n.HasSecurityAccess,
    uiData: n.UIData,
    variablesUIData: n.VariablesUIData,
    dataSource: ds && typeof ds === "object" ? { type: Type, ...dsRest } : ds,
    parameters: rows(n.Parameters, (p) => ({
      name: p.Name,
      type: p.Type,
      value: p.Value,
      ...(p.Prompt !== undefined ? { prompt: p.Prompt } : {}),
    })),
    variables: rows(n.Variables, (v) => ({
      name: v.Name,
      type: v.Type,
      position: v.Position,
      ...(v.StartByte !== undefined ? { startByte: v.StartByte } : {}),
      ...(v.EndByte !== undefined ? { endByte: v.EndByte } : {}),
    })),
  };
}

/** Parse a `{name}.json` + `{name}.ti` pair back into deployable process parts. */
export function parseProcessFromGit(
  jsonContent: string,
  tiContent: string,
): ParsedGitProcess {
  type Meta = {
    name?: unknown;
    hasSecurityAccess?: unknown;
    parameters?: unknown;
    variables?: unknown;
    variablesUIData?: unknown;
    uiData?: unknown;
    dataSource?: unknown;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(jsonContent);
  } catch {
    throw new Error("Process JSON is not valid JSON");
  }
  const meta: Meta =
    assertKnownJsonShape(raw) === "native"
      ? fromNative(raw as Record<string, unknown>)
      : (raw as Meta);

  // Zod drops unknown keys silently; a data source field it does not know
  // would be lost on deploy.
  if (meta.dataSource && typeof meta.dataSource === "object") {
    const extra = Object.keys(meta.dataSource).filter(
      (k) => !DATASOURCE_KEYS.has(k),
    );
    if (extra.length > 0) {
      throw new Error(
        `Process JSON has unknown 'dataSource' key(s): ${extra.join(", ")}. ` +
          "Refusing to deploy: they would be dropped without a word.",
      );
    }
  }
  if (meta.uiData !== undefined && typeof meta.uiData !== "string") {
    throw new Error("Process JSON has invalid 'UIData': expected a string");
  }

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
    ...(typeof meta.uiData === "string" ? { uiData: meta.uiData } : {}),
    dataSource,
  };
}
