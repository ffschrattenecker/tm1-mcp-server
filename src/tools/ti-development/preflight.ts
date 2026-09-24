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
// Before 5.0.0 the preflight ran the syntax check only. A deploy could compile
// cleanly and still install code that names a cube that does not exist — TM1
// never resolves names at compile time — which is how "validated a fragment,
// installed more" and silent cube substitution got through.
import type { TM1Client } from "../../tm1-client.js";
import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../../types.js";
import { TM1ErrorCode } from "../../types.js";
import { checkProcessRefs, type RefIssue } from "../../lib/process-refs.js";

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
  const check = await tm1Client.processes.check({
    name: p.name,
    prolog: p.prolog,
    metadata: p.metadata,
    data: p.data,
    epilog: p.epilog,
    ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
    ...(p.variables !== undefined ? { variables: p.variables } : {}),
    ...(p.dataSource !== undefined ? { dataSource: p.dataSource } : {}),
  });
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
    const names = [...new Set(refs.issues.map((i) => `${i.kind} '${i.name}'`))];
    return {
      stage: "preflight",
      check: "references",
      processName: p.name,
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Preflight reference check failed: ${names.join(", ")} not found on the server.`,
      hint: `Correct the name (tm1_list_cubes / tm1_list_dimensions), or create the object first. ${SKIP_NOTE}`,
      issues: refs.issues,
    };
  }
  return undefined;
}

/** The isError tool result for a failed preflight. */
export function preflightResult(failure: PreflightFailure) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(failure) }],
    isError: true as const,
  };
}
