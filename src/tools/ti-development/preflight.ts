// Install-time preflight shared by every tool that writes process code:
// tm1_upsert_process, tm1_import_pro_file, tm1_import_process_from_git and
// tm1_install_pro_bundle.
//
// Two checks, both on the EXACT payload about to be installed — every tab,
// with the parameters and variables it will run with:
//   1. syntax  — tm1.CompileProcess on an unsaved body (tm1_check_process_code)
//   2. references — every literal cube/dimension name resolves on the server,
//      or is created by the same code (tm1_validate_process_refs)
//
// Checks references as well as syntax (see src/lib/process-refs.ts).
import type { TM1Client } from "../../tm1-client.js";
import type { TiTab } from "../../schemas/processes.js";
import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../../types.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { checkProcessRefs, type RefIssue } from "../../lib/process-refs.js";
import { lintReport } from "../../lib/complexity/antipatterns.js";
import { withToolHint } from "../error-format.js";

export interface PreflightPayload {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  parameters?: ProcessParameter[];
  variables?: ProcessVariable[];
  dataSource?: DataSource;
}

export interface PreflightFailure {
  stage: "preflight";
  check: "syntax" | "references";
  processName: string;
  code: typeof TM1ErrorCode.VALIDATION_ERROR;
  message: string;
  hint: string;
  errors?: Array<{
    procedure?: string | undefined;
    lineNumber?: number | undefined;
    message: string;
  }>;
  issues?: RefIssue[];
}

const SKIP_NOTE =
  "Nothing was installed. preflight:false skips BOTH the syntax and the reference check — use it only for a name the code creates at runtime in a way the check cannot see.";

/** Undefined when the payload passes both checks. */
export async function runPreflight(
  tm1Client: TM1Client,
  p: PreflightPayload,
): Promise<PreflightFailure | undefined> {
  const check = await tm1Client.processes.check(p);
  if (!check.success) {
    return {
      stage: "preflight",
      check: "syntax",
      processName: p.name,
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Preflight syntax check failed: ${check.errors.length} error(s).`,
      hint: `Fix the lines in errors[] (procedure + lineNumber). ${SKIP_NOTE}`,
      errors: check.errors,
    };
  }
  const refs = await checkProcessRefs(tm1Client, p);
  if (refs.unresolved > 0) {
    const missing = new Set<string>();
    const misused = new Set<string>();
    const hints: string[] = [];
    for (const i of refs.issues) {
      if (i.kind === "elementCount") {
        misused.add(
          `a cell call on cube '${i.name}' passes ${i.got} element(s), the cube takes ${i.expected} (${i.tab} line ${i.line})`,
        );
      } else if (i.kind === "uncommittedElement") {
        misused.add(
          `an attribute is written on element '${i.name}' of '${i.dimension}' in the same ${i.tab} tab that inserts it (line ${i.line})`,
        );
      } else {
        missing.add(
          i.kind === "element"
            ? `element '${i.name}' in dimension '${i.dimension}'`
            : `${i.kind} '${i.name}'`,
        );
      }
    }
    const parts: string[] = [];
    if (missing.size) {
      parts.push(`${[...missing].join(", ")} not found on the server`);
      // Deliberately not "correct the name": a near match (SalesPlan for
      // 'Sales Plan') is a different object, and swapping it in unasked is
      // the silent substitution this check exists to stop.
      hints.push(
        "Report each unresolved name to the user before changing anything — a similarly named object is a different object, not a fix. Create the object first if the code needs it.",
      );
    }
    if (misused.size) parts.push(...misused);
    if (refs.issues.some((i) => i.kind === "elementCount"))
      hints.push(
        "Pass one element per cube dimension, leaving out Sandboxes (the run aborts with 'Wrong Number of Dimension Elements').",
      );
    if (refs.issues.some((i) => i.kind === "uncommittedElement"))
      hints.push(
        "The insert is not committed until the tab ends, so the attribute write fails with 'Element not found' on the run that creates the element: use DimensionElementInsertDirect, or write the attribute in a later tab.",
      );
    return {
      stage: "preflight",
      check: "references",
      processName: p.name,
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Preflight reference check failed: ${parts.join("; ")}.`,
      hint: `${hints.join(" ")} ${SKIP_NOTE}`,
      issues: refs.issues,
    };
  }
  return undefined;
}

export interface LintChecks {
  findings: Array<{
    tab: string;
    line: number;
    rule: string;
    severity: "error" | "warn" | "info";
    snippet: string;
    hint: string;
  }>;
  unparsedTabs: string[];
}

/**
 * Offline lint of code that is about to compile. Advisory: it never changes
 * `ok`. On a fragment (`partial`), dead-assignment is dropped because the
 * read may sit in a tab that was not passed.
 */
export function lintCode(
  name: string,
  tabs: Partial<Record<TiTab, string | undefined>>,
  partial = false,
): LintChecks {
  const r = lintReport(name, {
    prolog: tabs.prolog ?? "",
    metadata: tabs.metadata ?? "",
    data: tabs.data ?? "",
    epilog: tabs.epilog ?? "",
  });
  return {
    findings: r.findings
      .filter((f) => !(partial && f.rule === "dead-assignment"))
      .map((f) => ({
        tab: f.tab,
        line: f.line,
        rule: f.rule,
        severity: f.severity,
        snippet: f.snippet,
        hint: f.hint,
      })),
    unparsedTabs: r.unparsedTabs,
  };
}

export interface PreflightChecks {
  ok: boolean;
  /** Advisory: not part of `ok`. */
  lint: LintChecks;
  syntax: {
    ok: boolean;
    errors: Array<{
      procedure?: string | undefined;
      lineNumber?: number | undefined;
      message: string;
    }>;
  };
  references: {
    ok: boolean;
    unresolved: number;
    issues: RefIssue[];
    partial: boolean;
    unresolvableArgs: number;
  };
}

/**
 * Both checks, neither short-circuiting the other: the dryRun report the
 * user approves from. runPreflight stops at the first failure because the
 * install is refused either way; a pre-approval report needs every finding.
 */
export async function runChecks(
  tm1Client: TM1Client,
  p: PreflightPayload,
): Promise<PreflightChecks> {
  const [check, refs] = await Promise.all([
    tm1Client.processes.check(p),
    checkProcessRefs(tm1Client, p),
  ]);
  const references = {
    ok: refs.unresolved === 0,
    unresolved: refs.unresolved,
    issues: refs.issues,
    partial: refs.partial,
    unresolvableArgs: refs.unresolvableArgs,
  };
  return {
    ok: check.success && references.ok,
    syntax: { ok: check.success, errors: check.errors },
    references,
    lint: lintCode(p.name, p),
  };
}

export interface DeployParts {
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  variablesUIData?: string[];
  dataSource: DataSource;
  uiData?: string;
  hasSecurityAccess?: boolean;
}

function withHint(p: Promise<void>, hint: string | undefined): Promise<void> {
  return hint === undefined ? p : withToolHint(p, hint);
}

/**
 * Deploy steps after the code is written: parameters, variables, datasource,
 * then deploy meta. The file is the whole truth, so an empty list or a None
 * source is sent too; TM1 applies both (measured on 11.8 and 12.5). With
 * `skipEmptyIfNew`, a process this call creates skips the empty steps.
 * Variables without a column layout keep the server's layout; with one they
 * replace it. A POST does not create UIData and a PATCH without it leaves it
 * alone, so deploy meta is sent only when one of its fields is set.
 */
async function applyDeployParts(
  processes: TM1Client["processes"],
  processName: string,
  parts: DeployParts,
  opts: {
    exists: boolean;
    skipEmptyIfNew?: boolean;
    hints?: ReturnType<typeof installHints> | undefined;
  },
): Promise<void> {
  const all = opts.exists || !opts.skipEmptyIfNew;
  const hints = opts.hints;
  if (all || parts.parameters.length > 0) {
    await withHint(
      processes.updateParameters(processName, parts.parameters),
      hints?.parameters,
    );
  }
  if (
    all ||
    parts.variables.length > 0 ||
    parts.variablesUIData !== undefined
  ) {
    await withHint(
      processes.updateVariables(
        processName,
        parts.variables,
        parts.variablesUIData,
      ),
      hints?.variables,
    );
  }
  if (all || parts.dataSource.type !== "None") {
    await withHint(
      processes.updateDataSource(processName, parts.dataSource),
      hints?.dataSource,
    );
  }
  if (parts.uiData !== undefined || parts.hasSecurityAccess !== undefined) {
    await withHint(
      processes.updateDeployMeta(processName, {
        uiData: parts.uiData,
        hasSecurityAccess: parts.hasSecurityAccess,
      }),
      hints?.deployMeta,
    );
  }
}

// Hint per install step; each names the state a failure leaves behind.
export function installHints(n: string, exists: boolean, dsType: string) {
  return {
    create: `Process create failed mid-import. Name '${n}' may already exist (mode=create would have caught — likely race) or contain invalid characters. Verify state with tm1_rest_read Processes('${n}')?$select=Name before retry.`,
    code: `Code update failed after process '${n}' was ${exists ? "located" : "created"}. PARTIAL APPLY: the process shell exists but tabs are stale/empty. Re-run with mode=update once root cause fixed, or tm1_rest_write DELETE Processes('${n}') to roll back.`,
    parameters: `Parameter update failed for '${n}'. Code applied but parameters missing. tm1_upsert_process with mode=update + parameters=[...] to recover.`,
    variables: `Variable update failed for '${n}'. Code+parameters applied but variables missing. tm1_upsert_process with mode=update + variables=[...] to recover.`,
    dataSource: `Datasource update failed for '${n}' (type=${dsType}). Code+params+vars applied. Verify datasource credentials/path (ASCII file existence, ODBC DSN or dataSourcePassword, view name) and re-run with mode=update, or tm1_upsert_process with mode=update + dataSource={...}.`,
    deployMeta: `HasSecurityAccess/UIData update failed for '${n}'. Code+params+vars+datasource applied. Re-run with mode=update once root cause fixed.`,
  };
}

// Create (when new), write the code, then the deploy parts. The caller runs
// the mode, confirm and backup gates first. No hints: errors pass through.
export async function writeInstall(
  processes: TM1Client["processes"],
  processName: string,
  def: DeployParts & Record<TiTab, string>,
  opts: {
    exists: boolean;
    skipEmptyIfNew?: boolean;
    hints?: ReturnType<typeof installHints>;
    writeCode?: () => Promise<void>;
  },
): Promise<void> {
  if (!opts.exists)
    await withHint(processes.create(processName), opts.hints?.create);
  await withHint(
    opts.writeCode?.() ?? processes.updateCode(processName, def),
    opts.hints?.code,
  );
  await applyDeployParts(processes, processName, def, {
    exists: opts.exists,
    skipEmptyIfNew: opts.skipEmptyIfNew ?? false,
    hints: opts.hints,
  });
}

// The error a create/update mode refuses, or undefined when the install may run.
export function deployModeError(
  mode: "create" | "update" | "upsert",
  exists: boolean,
  processName: string,
): TM1Error | undefined {
  if (mode === "create" && exists)
    return new TM1Error({
      code: TM1ErrorCode.CONFLICT,
      message: `Process '${processName}' already exists; mode=create`,
    });
  if (mode === "update" && !exists)
    return new TM1Error({
      code: TM1ErrorCode.NOT_FOUND,
      message: `Process '${processName}' does not exist; mode=update`,
    });
  return undefined;
}
