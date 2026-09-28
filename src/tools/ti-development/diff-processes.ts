import { z } from "zod";
import type {
  IgnoredColumn,
  ProcessParameter,
  ProcessVariable,
  DataSource,
} from "../../types.js";
import { maskCode, resolveMaskSecrets } from "../../lib/mask-secrets.js";
import { DiffProcessesResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { tabCodeDiff } from "../../lib/line-diff.js";

// ── param / var / datasource diff ────────────────────────────────────────────

export function diffParams(a: ProcessParameter[], b: ProcessParameter[]) {
  const ma = new Map(a.map((p) => [p.name, p]));
  const mb = new Map(b.map((p) => [p.name, p]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{
    name: string;
    a: ProcessParameter;
    b: ProcessParameter;
  }> = [];
  for (const [name, pb] of mb) {
    const pa = ma.get(name);
    if (!pa) {
      added.push(name);
      continue;
    }
    if (
      pa.type !== pb.type ||
      String(pa.defaultValue ?? "") !== String(pb.defaultValue ?? "") ||
      (pa.prompt ?? "") !== (pb.prompt ?? "")
    ) {
      changed.push({ name, a: pa, b: pb });
    }
  }
  for (const name of ma.keys()) if (!mb.has(name)) removed.push(name);
  return {
    identical:
      added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}

export function diffVars(a: ProcessVariable[], b: ProcessVariable[]) {
  const ma = new Map(a.map((v) => [v.name, v]));
  const mb = new Map(b.map((v) => [v.name, v]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{
    name: string;
    a: ProcessVariable;
    b: ProcessVariable;
  }> = [];
  for (const [name, vb] of mb) {
    const va = ma.get(name);
    if (!va) {
      added.push(name);
      continue;
    }
    if (va.type !== vb.type || va.position !== vb.position)
      changed.push({ name, a: va, b: vb });
  }
  for (const name of ma.keys()) if (!mb.has(name)) removed.push(name);
  return {
    identical:
      added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}

// Columns set to "Ignore" carry no variable, so diffVars above cannot see
// them: two processes differing only in which columns they skip would otherwise
// come back identical.
function diffIgnoredColumns(a: IgnoredColumn[], b: IgnoredColumn[]) {
  const ma = new Map(a.map((c) => [c.position, c]));
  const mb = new Map(b.map((c) => [c.position, c]));
  const added: number[] = [];
  const removed: number[] = [];
  const renamed: Array<{ position: number; a?: string; b?: string }> = [];
  for (const [position, cb] of mb) {
    const ca = ma.get(position);
    if (!ca) {
      added.push(position);
      continue;
    }
    if (ca.name !== cb.name)
      renamed.push({
        position,
        ...(ca.name !== undefined ? { a: ca.name } : {}),
        ...(cb.name !== undefined ? { b: cb.name } : {}),
      });
  }
  for (const position of ma.keys())
    if (!mb.has(position)) removed.push(position);
  return {
    identical:
      added.length === 0 && removed.length === 0 && renamed.length === 0,
    added,
    removed,
    renamed,
  };
}

// Shared with tm1_diff_process_with_file so both diffs check the same fields.
export function diffDs(a: DataSource, b: DataSource) {
  const diffs: string[] = [];
  const fields: Array<keyof DataSource> = [
    "type",
    "dataSourceNameForServer",
    "dataSourceNameForClient",
    "asciiDelimiterChar",
    "asciiQuoteCharacter",
    "asciiDecimalSeparator",
    "asciiThousandSeparator",
    "asciiHeaderRecords",
    "view",
    "subset",
    "userName",
    // The SQL is the substance of an ODBC source: two processes that differ
    // only in their query are not the same process. `password` stays out —
    // both sides read back redacted, so it can only produce noise.
    "query",
  ];
  for (const f of fields) {
    if ((a[f] ?? "") !== (b[f] ?? ""))
      diffs.push(
        `${String(f)}: ${JSON.stringify(a[f])} → ${JSON.stringify(b[f])}`,
      );
  }
  // Compared with their defaults filled in: the .pro parser sets the
  // delimiter type only on ASCII sources and v12 never returns usesUnicode,
  // so a bare comparison would report a difference nobody made.
  const delimiter = (d: DataSource) =>
    d.type === "ASCII" ? (d.asciiDelimiterType ?? "Character") : undefined;
  if (delimiter(a) !== delimiter(b))
    diffs.push(
      `asciiDelimiterType: ${JSON.stringify(delimiter(a))} → ${JSON.stringify(delimiter(b))}`,
    );
  if ((a.usesUnicode ?? false) !== (b.usesUnicode ?? false))
    diffs.push(
      `usesUnicode: ${JSON.stringify(a.usesUnicode ?? false)} → ${JSON.stringify(b.usesUnicode ?? false)}`,
    );
  return { identical: diffs.length === 0, differences: diffs };
}

// ── tool ──────────────────────────────────────────────────────────────────────

const ALL_TABS = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof ALL_TABS)[number];

export const registerDiffProcesses = defineTool({
  name: "tm1_diff_processes",
  description: [
    "Compare two installed TI processes tab-by-tab (Prolog/Metadata/Data/Epilog), on one connection or across two (connectionB, e.g. DEV vs PROD).",
    "Returns per-tab identical flag, line counts, and unified diff hunks for changed tabs.",
    "Also diffs parameters, variables, and datasource.",
    "Analogue of tm1_diff_process_with_file but server-side — no .pro file needed.",
  ],
  annotations: READ_ONLY,
  peer: true,
  output: DiffProcessesResultSchema,
  input: {
    processA: z.string().describe("First process name (case-sensitive)"),
    processB: z
      .string()
      .optional()
      .describe(
        "Second process name (case-sensitive), read from connectionB. Default: processA, i.e. the same process on the other connection.",
      ),
    tabs: z
      .array(z.enum(["prolog", "metadata", "data", "epilog"]))
      .optional()
      .describe("Tabs to diff (default: all four)"),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe(
        "Lines of context around each changed hunk (default 3, max 10)",
      ),
    maskSecrets: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Redact credential literals on BOTH sides before diffing (so a cred present on only one side can't leak via the diff). " +
          "Masks the password arg of ODBCOpen() and quoted values assigned to credential-named identifiers (pPwd, sToken, …). " +
          "Default: true. Set false only when explicitly auditing credentials.",
      ),
  },
  handler: async (
    { processA, processB: processBArg, tabs, contextLines, maskSecrets },
    { a, b },
  ) => {
    const processB = processBArg ?? processA;
    const diffTabs: readonly Tab[] = tabs && tabs.length > 0 ? tabs : ALL_TABS;
    const mask = resolveMaskSecrets(maskSecrets) ? maskCode : (s: string) => s;

    const [codeA, codeB, paramsA, paramsB, varsA, varsB, dsA, dsB] =
      await Promise.all([
        a.client.processes.getCode(processA),
        b.client.processes.getCode(processB),
        a.client.processes.getParameters(processA),
        b.client.processes.getParameters(processB),
        a.client.processes.getVariableLayout(processA),
        b.client.processes.getVariableLayout(processB),
        a.client.processes.getDataSource(processA),
        b.client.processes.getDataSource(processB),
      ]);

    const tabResults: Record<string, ReturnType<typeof tabCodeDiff>> = {};
    for (const tab of diffTabs) {
      tabResults[tab] = tabCodeDiff(
        mask(codeA[tab] ?? ""),
        mask(codeB[tab] ?? ""),
        contextLines,
      );
    }

    const parameters = diffParams(paramsA, paramsB);
    const variables = diffVars(varsA.variables, varsB.variables);
    const ignoredColumns = diffIgnoredColumns(
      varsA.ignoredColumns,
      varsB.ignoredColumns,
    );
    const dataSource = diffDs(dsA, dsB);

    const identical =
      Object.values(tabResults).every((t) => t.identical) &&
      parameters.identical &&
      variables.identical &&
      ignoredColumns.identical &&
      dataSource.identical;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              processA,
              processB,
              connectionA: a.name,
              connectionB: b.name,
              identical,
              tabs: tabResults,
              parameters,
              variables,
              ignoredColumns,
              dataSource,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
