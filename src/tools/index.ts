import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientSource, ToolRegistrar } from "./define-tool.js";

// Metadata tools
import { registerResolveDefaultMembers } from "./metadata/resolve-default-members.js";
import { registerListProcessesGrouped } from "./metadata/list-processes-grouped.js";

// Cell data tools
import { registerExecuteMdx } from "./celldata/execute-mdx.js";
import { registerGetView } from "./celldata/get-view.js";
import { registerSampleCells } from "./celldata/sample-cells.js";
import { registerWriteCells } from "./celldata/write-cells.js";
import { registerCheckFeeders } from "./celldata/check-feeders.js";
import { registerTraceFeeders } from "./celldata/trace-feeders.js";
import { registerTraceCellCalculation } from "./celldata/trace-cell-calculation.js";

// TI development tools (process read/write, execution, code, .pro and git)
import { registerExecuteProcess } from "./ti-development/execute-process.js";
import { registerGetProcess } from "./ti-development/get-process.js";
import { registerCopyProcess } from "./ti-development/copy-process.js";
import { registerCheckProcessCode } from "./ti-development/check-process-code.js";
import { registerGetAllProcessesCode } from "./ti-development/get-all-processes-code.js";
import { registerSearchCode } from "./ti-development/search-code.js";
import { registerImportProFile } from "./ti-development/import-pro-file.js";
import { registerExportProcessToPro } from "./ti-development/export-process-to-pro.js";
import { registerDiffProcessWithFile } from "./ti-development/diff-process-with-file.js";
import { registerDiffProcesses } from "./ti-development/diff-processes.js";
import { registerValidateProcessRefs } from "./ti-development/validate-process-refs.js";
import { registerUpsertProcess } from "./ti-development/upsert-process.js";
import { registerInstallProBundle } from "./ti-development/install-pro-bundle.js";
import { registerExportProcessToGit } from "./ti-development/export-process-to-git.js";
import { registerImportProcessFromGit } from "./ti-development/import-process-from-git.js";
import { registerCheckWritableCoords } from "./celldata/check-writable-coords.js";

// Dimension management tools
import { registerDeleteElements } from "./dimension-management/delete-elements.js";
import { registerBulkUpsertElements } from "./dimension-management/bulk-upsert-elements.js";
import { registerUpdateElementAttributeValue } from "./dimension-management/update-element-attribute-value.js";

// Model building tools
import { registerGetCubeRules } from "./model-building/get-cube-rules.js";
import { registerSetCubeRules } from "./model-building/set-cube-rules.js";
import { registerClearCube } from "./model-building/clear-cube.js";
import { registerGetAllCubeRules } from "./model-building/get-all-cube-rules.js";
import { registerCheckCubeRule } from "./model-building/check-cube-rule.js";
import { registerSearchRules } from "./model-building/search-rules.js";

// Scheduling tools
import { registerExecuteChore } from "./scheduling/execute-chore.js";
import { registerUpdateChore } from "./scheduling/update-chore.js";

// Operations tools
import { registerListConnections } from "./operations/list-connections.js";
import { registerGetServerState } from "./operations/get-server-state.js";
import { registerListErrorLogs } from "./operations/list-error-logs.js";
import { registerGetErrorLogContent } from "./operations/get-error-log-content.js";
import { registerDiagnoseProcessError } from "./operations/diagnose-process-error.js";
import { registerGetCubeStats } from "./operations/get-cube-stats.js";
import { registerSaveData } from "./operations/save-data.js";

// File operations tools
import { registerFilesRead } from "./fileops/files-read.js";
import { registerFilesWrite } from "./fileops/files-write.js";

// Generic REST tools
import { registerRestRead } from "./rest/rest-read.js";
import { registerRestWrite } from "./rest/rest-write.js";

// Analysis tools
import { registerAnalyzeCallgraph } from "./analysis/analyze-callgraph.js";
import { registerAnalyzeObjectUsage } from "./analysis/analyze-object-usage.js";
import { registerTraceDataFlow } from "./analysis/trace-data-flow.js";
import { registerAnalyzeChoreGraph } from "./analysis/analyze-chore-graph.js";
import { registerDiffCubeRules } from "./analysis/diff-cube-rules.js";
import { registerDiffHierarchy } from "./analysis/diff-hierarchy.js";
import { registerCompareEnvironments } from "./analysis/compare-environments.js";
import { registerCheckV12Readiness } from "./analysis/check-v12-readiness.js";
import { registerAuditNaming } from "./analysis/audit-naming.js";
import { registerAuditComplexity } from "./analysis/audit-complexity.js";
import { registerAuditFeeders } from "./analysis/audit-feeders.js";

// Single registry of every tool registrar, grouped by category. Adding a tool
// = add its import above and one entry here (adjacent edit, one PR hunk). The
// previous design kept a second hand-ordered call block that drifted from the
// import order; this array is the only call site. check-conventions.mjs
// fails the build if a `register*` export under src/tools/ is missing here.
const REGISTRARS: ToolRegistrar[] = [
  // Metadata
  registerResolveDefaultMembers,
  registerListProcessesGrouped,

  // Cell data
  registerExecuteMdx,
  registerGetView,
  registerSampleCells,
  registerWriteCells,
  registerCheckFeeders,
  registerTraceFeeders,
  registerTraceCellCalculation,
  registerCheckWritableCoords,

  // TI development — writes go through registerUpsertProcess and reads
  // through registerGetProcess (include-flags pick the parts).
  registerExecuteProcess,
  registerGetProcess,
  registerCopyProcess,
  registerCheckProcessCode,
  registerGetAllProcessesCode,
  registerSearchCode,
  registerImportProFile,
  registerExportProcessToPro,
  registerDiffProcessWithFile,
  registerDiffProcesses,
  registerValidateProcessRefs,
  registerUpsertProcess,
  registerInstallProBundle,
  registerExportProcessToGit,
  registerImportProcessFromGit,

  // Dimension management
  registerBulkUpsertElements,
  registerDeleteElements,
  registerUpdateElementAttributeValue,

  // Model building
  registerGetCubeRules,
  registerSetCubeRules,
  registerClearCube,
  registerGetAllCubeRules,
  registerCheckCubeRule,
  registerSearchRules,

  // Scheduling
  registerExecuteChore,
  registerUpdateChore,

  // Operations
  registerListConnections,
  registerGetServerState,
  registerListErrorLogs,
  registerGetErrorLogContent,
  registerDiagnoseProcessError,
  registerGetCubeStats,
  registerSaveData,

  // File operations
  registerFilesRead,
  registerFilesWrite,

  // Generic REST
  registerRestRead,
  registerRestWrite,

  // Analysis
  registerAnalyzeCallgraph,
  registerAnalyzeObjectUsage,
  registerTraceDataFlow,
  registerAnalyzeChoreGraph,
  registerDiffCubeRules,
  registerDiffHierarchy,
  registerCompareEnvironments,
  registerCheckV12Readiness,
  registerAuditNaming,
  registerAuditComplexity,
  registerAuditFeeders,
];

export function registerAllTools(
  server: McpServer,
  source: ClientSource,
): void {
  for (const register of REGISTRARS) register(server, source);
}
