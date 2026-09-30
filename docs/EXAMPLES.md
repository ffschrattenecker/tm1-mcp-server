# tm1-mcp-server Examples

Working examples for every major feature. Snippets are JSON tool-call payloads — paste into any MCP-aware client (Claude Code, Claude Desktop, etc.). Defaults assume server name `tm1`.

> Tip: the list/search tools and a few readers accept `format: "json"|"markdown"` (see [Markdown vs. JSON output](#markdown-vs-json-output)). Default is `json` (parsed into `structuredContent` by the server); use `"markdown"` when you want a readable table dropped straight into chat.

Objects without a dedicated tool — cubes, dimensions, hierarchies, elements, subsets, views, chores, users, groups, logs — are read with `tm1_rest_read` and changed with `tm1_rest_write`. `path` is relative to `/api/v1/`.

---

## 1. Metadata listing

> **REST tool traps**
>
> - Collections include `}` control objects. Add `$filter=not startswith(Name,'}')` to leave them out.
> - OData string comparisons are case-sensitive: wrap the name in `tolower()` for a name search.
> - With sandboxing on, every cube lists the shared `Sandboxes` dimension first in its dimensions.
> - TM1 refuses to create a cube with fewer than two dimensions.
> - v12 serves `MessageLogEntries`, `AuditLogEntries` and `TransactionLogEntries` empty — an empty result there means no data, not "nothing happened".
> - A transaction-log read is a server-side scan: always bound it with a `TimeStamp ge` filter.

### 1.1 List user-defined cubes only

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "Cubes?$select=Name&$filter=not startswith(Name,'}')&$top=100"
  }
}
```

### 1.2 Find all cubes whose name contains a word, with their dimensions

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "Cubes?$select=Name&$filter=contains(tolower(Name),'sales')&$expand=Dimensions($select=Name)"
  }
}
```

### 1.3 Headcount: dimensions with their hierarchy element counts

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "Dimensions?$select=Name&$filter=not startswith(Name,'}')&$expand=Hierarchies($select=Name,Cardinality)"
  }
}
```

### 1.4 Show TI processes grouped by name prefix (audit shape)

```json
{
  "tool": "tm1_list_processes_grouped",
  "args": {
    "prefixSegments": 1,
    "minCount": 3,
    "excludePattern": "^Bedrock\\."
  }
}
```

### 1.5 Elements of a hierarchy, and its parent/child edges

```json
[
  {
    "tool": "tm1_rest_read",
    "args": {
      "path": "Dimensions('Region')/Hierarchies('Region')/Elements?$select=Name,Type&$filter=Type eq 'Consolidated'&$top=50"
    }
  },
  {
    "tool": "tm1_rest_read",
    "args": { "path": "Dimensions('Region')/Hierarchies('Region')/Edges" }
  }
]
```

`…/Elements/$count` returns the element count alone.

---

## 2. Cell data — read

### 2.1 Execute MDX with paginated cells

```json
{
  "tool": "tm1_execute_mdx",
  "args": {
    "mdx": "SELECT NON EMPTY {[Versions].[Actual]} ON 0, NON EMPTY {[Year].[2024]} ON 1 FROM [Sales]",
    "limit": 50
  }
}
```

### 2.2 Read a single cell value

```json
{
  "tool": "tm1_execute_mdx",
  "args": {
    "mdx": "SELECT {([Year].[Year].[2024], [Region].[Region].[DE], [Product].[Product].[P001], [Versions].[Versions].[Actual], [Measures].[Measures].[Amount])} ON 0 FROM [Sales]"
  }
}
```

### 2.3 Sample N random populated cells (audit / smoke-test)

```json
{
  "tool": "tm1_sample_cells",
  "args": { "cubeName": "Sales", "maxCells": 20 }
}
```

---

## 3. Cell data — write (use sparingly; prefer TI)

### 3.1 Pre-flight check writable coords (rule overlap, N-level)

```json
{
  "tool": "tm1_check_writable_coords",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "coords": ["2024", "DE", "P001", "Budget", "Amount"]
  }
}
```

### 3.2 Write one cell

```json
{
  "tool": "tm1_write_cells",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "cells": [
      { "elements": ["2024", "DE", "P001", "Budget", "Amount"], "value": 100 }
    ],
    "confirm": "Sales"
  }
}
```

### 3.3 Bulk write batch of cells

```json
{
  "tool": "tm1_write_cells",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "cells": [
      { "elements": ["2024", "DE", "P001", "Budget", "Amount"], "value": 100 },
      { "elements": ["2024", "DE", "P002", "Budget", "Amount"], "value": 250 },
      { "elements": ["2024", "FR", "P001", "Budget", "Amount"], "value": 80 }
    ],
    "confirm": "Sales"
  }
}
```

---

## 4. TI Development

### 4.1 Validate code without saving (pre-flight)

```json
{
  "tool": "tm1_check_process_code",
  "args": {
    "processName": "Load_Sales",
    "prolog": "DatasourceNameForServer = '|filename|';",
    "data": "CellPutN(NValue, 'Sales', vYear, vRegion, vProduct, 'Actual', 'Amount');",
    "parameters": [
      {
        "name": "filename",
        "type": "String",
        "defaultValue": "sales_2024.csv"
      }
    ]
  }
}
```

### 4.2 Atomic create-with-bundle (parameters + variables + code)

```json
{
  "tool": "tm1_upsert_process",
  "args": {
    "processName": "Load_Sales",
    "mode": "create",
    "parameters": [
      { "name": "filename", "type": "String", "defaultValue": "sales.csv" }
    ],
    "variables": [],
    "dataSource": { "type": "ASCII", "dataSourceNameForServer": "sales.csv" },
    "prolog": "...",
    "metadata": "...",
    "data": "...",
    "epilog": "..."
  }
}
```

### 4.3 Diff installed process vs. local .pro file

```json
{
  "tool": "tm1_diff_process_with_file",
  "args": {
    "processName": "Load_Sales",
    "filePath": "/path/to/Load_Sales.pro"
  }
}
```

### 4.4 Search across all TI source code

```json
{
  "tool": "tm1_search_code",
  "args": {
    "pattern": "ExecuteProcess.*Bedrock",
    "maxTotalMatches": 100
  }
}
```

### 4.5 Compile an installed process

```json
{
  "tool": "tm1_rest_read",
  "args": { "path": "Processes('Load_Sales')/tm1.Compile" }
}
```

An empty result means it compiles. Delete a process with
`tm1_rest_write` `DELETE Processes('Load_Sales')` and `confirm: "Load_Sales"`;
creating or changing one goes through `tm1_upsert_process`.

---

## 5. TI Lifecycle (.pro files)

### 5.1 Import a .pro file (parse + deploy in one call)

```json
{
  "tool": "tm1_import_pro_file",
  "args": {
    "filePath": "/path/to/Load_Sales.pro",
    "mode": "upsert",
    "confirm": "Load_Sales"
  }
}
```

`confirm` is only needed when the process already exists.

### 5.2 Install a directory of .pro files

```json
{
  "tool": "tm1_install_pro_bundle",
  "args": { "directory": "/path/to/processes", "mode": "create" }
}
```

### 5.3 Export installed process to .pro

```json
{
  "tool": "tm1_export_process_to_pro",
  "args": {
    "processName": "Load_Sales",
    "writeToFile": "/tmp/Load_Sales.pro"
  }
}
```

`writeToFile` needs `TM1_LOCAL_FILE_ROOT`; without it the `.pro` content comes back inline.

---

## 6. Subsets / Views

### 6.1 List subsets of a hierarchy

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "Dimensions('Region')/Hierarchies('Region')/Subsets?$select=Name,Expression"
  }
}
```

### 6.2 Create an MDX-based public view

```json
{
  "tool": "tm1_rest_write",
  "args": {
    "method": "POST",
    "path": "Cubes('Sales')/Views",
    "body": {
      "@odata.type": "#ibm.tm1.api.v1.MDXView",
      "Name": "v_Sales_2024_DE",
      "MDX": "SELECT {[Year].[2024]} ON 0, {[Region].[DE].Children} ON 1 FROM [Sales]"
    }
  }
}
```

Private views live under `Cubes('Sales')/PrivateViews`. Read the definition back with `tm1_rest_read Cubes('Sales')/Views('v_Sales_2024_DE')`; run it with `tm1_get_view`.

### 6.2b Create a native (subset-based) view — TI datasource / suppressed export

```json
{
  "tool": "tm1_rest_write",
  "args": {
    "method": "POST",
    "path": "Cubes('Sales')/Views",
    "body": {
      "@odata.type": "#ibm.tm1.api.v1.NativeView",
      "Name": "v_Sales_Export",
      "Rows": [
        {
          "Subset@odata.bind": "Dimensions('Region')/Hierarchies('Region')/Subsets('EU_Countries')"
        }
      ],
      "Columns": [
        {
          "Subset": {
            "Hierarchy@odata.bind": "Dimensions('Month')/Hierarchies('Month')",
            "Expression": "{TM1SUBSETALL([Month])}"
          }
        }
      ],
      "Titles": [
        {
          "Subset": {
            "Hierarchy@odata.bind": "Dimensions('Version')/Hierarchies('Version')",
            "Elements@odata.bind": [
              "Dimensions('Version')/Hierarchies('Version')/Elements('Actual')"
            ]
          },
          "Selected@odata.bind": "Dimensions('Version')/Hierarchies('Version')/Elements('Actual')"
        }
      ],
      "SuppressEmptyRows": true,
      "SuppressEmptyColumns": false
    }
  }
}
```

Every cube dimension must appear in exactly one of Rows/Columns/Titles. Per
axis entry one subset source: a registered subset (`Subset@odata.bind`), or an
anonymous `Subset` built from an MDX `Expression` or explicit
`Elements@odata.bind`. Titles need a selected element — TM1 rejects title
subsets without one.

### 6.3 Create a subset from an MDX expression

```json
{
  "tool": "tm1_rest_write",
  "args": {
    "method": "POST",
    "path": "Dimensions('Region')/Hierarchies('Region')/Subsets",
    "body": {
      "Name": "EU_Countries",
      "Expression": "{TM1FILTERBYLEVEL({TM1SUBSETALL([Region])}, 0)}"
    }
  }
}
```

A static subset takes `"Elements@odata.bind": ["Dimensions('Region')/Hierarchies('Region')/Elements('DE')", …]` instead of `Expression`.

---

## 7. Scheduling (chores)

### 7.1 Create a chore that runs daily at 06:00 UTC

```json
{
  "tool": "tm1_rest_write",
  "args": {
    "method": "POST",
    "path": "Chores",
    "body": {
      "Name": "DailyLoad",
      "StartTime": "2026-05-10T06:00:00Z",
      "DSTSensitive": false,
      "Active": false,
      "ExecutionMode": "MultipleCommit",
      "Frequency": "P1DT00H00M00S",
      "Tasks": [
        {
          "Step": 0,
          "Process@odata.bind": "Processes('Load_Sales')",
          "Parameters": [{ "Name": "filename", "Value": "sales.csv" }]
        },
        {
          "Step": 1,
          "Process@odata.bind": "Processes('Calc_KPIs')",
          "Parameters": []
        }
      ]
    }
  }
}
```

Change schedule or steps later with `tm1_update_chore`.

### 7.2 Activate or deactivate an existing chore

```json
{
  "tool": "tm1_rest_write",
  "args": {
    "method": "POST",
    "path": "Chores('DailyLoad')/tm1.Deactivate",
    "body": {}
  }
}
```

`tm1.Activate` turns it back on.

### 7.3 Run a chore on demand

```json
{
  "tool": "tm1_execute_chore",
  "args": { "choreName": "DailyLoad", "confirm": "DailyLoad" }
}
```

---

## 8. Security

### 8.1 List users with their groups

```json
{
  "tool": "tm1_rest_read",
  "args": { "path": "Users?$select=Name&$expand=Groups($select=Name)" }
}
```

### 8.2 Assign a user to a group

```json
{
  "tool": "tm1_rest_write",
  "args": {
    "method": "POST",
    "path": "Users('alice')/Groups/$ref",
    "body": { "@odata.id": "Groups('Finance')" }
  }
}
```

Removing the membership is `DELETE Users('alice')/Groups('Finance')/$ref` with
`confirm: "Finance"`.

### 8.3 Look up a single user's groups, or your own

```json
[
  {
    "tool": "tm1_rest_read",
    "args": {
      "path": "Users('alice')?$select=Name&$expand=Groups($select=Name)"
    }
  },
  {
    "tool": "tm1_rest_read",
    "args": { "path": "ActiveUser/Groups?$select=Name" }
  }
]
```

---

## 9. Operations / Diagnostics

### 9.1 Server health snapshot

```json
{ "tool": "tm1_get_server_state", "args": { "format": "markdown" } }
```

### 9.2 Diagnose a failed TI in one call (cascade-aware)

```json
{
  "tool": "tm1_diagnose_process_error",
  "args": {
    "processName": "Load_Sales",
    "since": "2026-05-09T00:00:00",
    "tail": 80,
    "includeRelated": true
  }
}
```

### 9.3 Recent transaction-log writes for one cube/user (v11)

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "TransactionLogEntries?$filter=Cube eq 'Sales' and User eq 'alice' and TimeStamp ge 2026-05-09T00:00:00Z&$orderby=TimeStamp desc&$top=50"
  }
}
```

The `TimeStamp ge` bound matters: the transaction log is scanned server-side,
and an open query can run for minutes. Use a zoned ISO literal (`…Z`).

### 9.4 Why is this cell X / empty? (calculation trace, v11)

```json
{
  "tool": "tm1_trace_cell_calculation",
  "args": {
    "cubeName": "Cube_PnL_Integration",
    "elements": [
      "2026_01",
      "Budget",
      "CC_SAP",
      "ACC_GrossSalary",
      "EUR",
      "AmountGroup"
    ],
    "maxDepth": 3,
    "maxComponents": 10
  }
}
```

Returns the recursive component tree (rule/consolidation/simple, values, rule
statements) — follows DB() references across cubes. `truncated: true` marks cut
branches; re-run with that node's `tuple`/`cube` to drill deeper.

### 9.5 Does this cell feed correctly? (feeder trace, v11)

```json
{
  "tool": "tm1_trace_feeders",
  "args": {
    "cubeName": "Cube_PnL_Integration",
    "elements": [
      "2026_01",
      "Budget",
      "CC_SAP",
      "ACC_GrossSalary",
      "EUR",
      "AmountLocal"
    ]
  }
}
```

Returns the cells this cell feeds plus the feeder statements that fire.
`tm1_check_feeders` (same args) verifies feeder coverage instead — an empty
result means no broken feeders detected.

### 9.6 Persist data to disk (v11)

```json
{ "tool": "tm1_save_data", "args": { "cube": "Sales" } }
```

Omit `cube` for SaveDataAll. Run after write sessions to persist in-memory
changes to disk — otherwise unsaved data is lost if the server crashes. It does
not clear or truncate the transaction log.

### 9.7 Who changed what? (audit log, v11)

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "AuditLogEntries?$filter=ObjectType eq 'Dimension' and TimeStamp ge 2026-06-01T00:00:00Z&$orderby=TimeStamp desc&$top=50&$expand=AuditDetails"
  }
}
```

Metadata/security changes (logins, object edits, chore runs) — complements the
transaction log (cell writes). Requires `AuditLogOn=T` in tm1s.cfg; an empty
result on an active server usually means auditing is disabled.

### 9.8 What is running right now?

```json
{
  "tool": "tm1_rest_read",
  "args": {
    "path": "Threads?$select=ID,Type,Name,State,Function,ObjectName,ElapsedTime,WaitTime"
  }
}
```

v12 has `Jobs` instead. Cancel with `tm1_rest_write` `POST Threads(42)/tm1.CancelOperation`
(v11) or `POST Jobs('id')/tm1.Cancel` (v12), `confirm` = the id.

---

## 10. Code-graph analysis

### 10.1 Full callgraph for one process (recursive)

```json
{
  "tool": "tm1_analyze_callgraph",
  "args": { "start": "Load_Sales", "mode": "full" }
}
```

Add `refresh: true` to rebuild the cached index first (after deploying processes outside this server).

### 10.2 Find every TI / chore / view that references a cube

```json
{
  "tool": "tm1_analyze_object_usage",
  "args": { "kind": "cube", "objectName": "Sales" }
}
```

### 10.3 Validate process references resolve (cube/dim names)

```json
{
  "tool": "tm1_validate_process_refs",
  "args": { "processName": "Load_Sales" }
}
```

---

## Markdown vs. JSON output

Add `format: "markdown"` to these tools for human-readable output:

`tm1_execute_mdx`, `tm1_get_view`, `tm1_files_read`, `tm1_get_cube_stats`, `tm1_get_server_state`, `tm1_list_error_logs`, `tm1_list_processes_grouped`, `tm1_search_code`, `tm1_search_rules`.

Default `json` is preferred for agent consumption — the server parses it into `structuredContent` so typed clients can consume the payload directly.

## MCP Resources

Beyond tools, the server exposes URI-addressable read-only resources. IDE clients (Kiro, VSCode Copilot Chat) can `#`-reference them in chat or browse a sidebar tree.

### List all resources

```jsonrpc
{ "jsonrpc": "2.0", "id": 1, "method": "resources/list" }
```

Returns 2 static + N process-code templates (one per non-control TI) + M cube-rules templates (one per cube with rules).

### Static resources

| URI                  | Mime             | Content                                                                                                   |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `tm1://server/info`  | application/json | identity only: server name, product version/edition, admin host, data directory, time zone, security mode |
| `tm1://server/state` | application/json | health snapshot: connected, version, object counts                                                        |

### Resource templates (dynamic)

| Template                    | Mime             | Content                                   |
| --------------------------- | ---------------- | ----------------------------------------- |
| `tm1://process/{name}/code` | application/json | Prolog/Metadata/Data/Epilog of TI process |
| `tm1://cube/{name}/rules`   | text/plain       | rules text (SKIPCHECK + FEEDERS)          |

### Read example

```jsonrpc
{ "jsonrpc": "2.0", "id": 2, "method": "resources/read",
  "params": { "uri": "tm1://process/Load_Sales/code" } }
```

URLs use URI-encoding for special characters (`/`, spaces, etc.).

## MCP Prompts

Slash-command workflow templates surfaced by IDE clients. Each prompt briefs the LLM with a concrete tool sequence.

### List

```jsonrpc
{ "jsonrpc": "2.0", "id": 1, "method": "prompts/list" }
```

### Available prompts

| Name                   | Args          | Use case                                                                        |
| ---------------------- | ------------- | ------------------------------------------------------------------------------- |
| `tm1_orientation`      | —             | First-call primer: how to navigate the model and which tool/prompt to reach for |
| `tm1_diagnose_process` | `processName` | Root-cause failed TI: error logs → cascade → params → code → refs → callgraph   |
| `tm1_audit_cube`       | `cubeName`    | Read-only health audit: shape → rules → stats → object-usage → tx log           |
| `tm1_health_check`     | —             | Server snapshot: state, sessions, threads, error logs, message log              |
| `tm1_rules_review`     | `cubeName`    | Code-review rules: SKIPCHECK, FEEDERS, N/C splits, syntax check, deps           |

### Get a prompt

```jsonrpc
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/get",
  "params": { "name": "tm1_diagnose_process",
              "arguments": { "processName": "Load_Sales" } } }
```

Returns one user message with the workflow text. The LLM follows it autonomously.

## Error hints

Failures return uniform JSON:

```json
{
  "code": "NOT_FOUND",
  "message": "Cube 'Saless' does not exist",
  "httpStatus": 404,
  "endpoint": "/api/v1/Cubes('Saless')",
  "hint": "Object does not exist. List the available names with tm1_rest_read (e.g. Cubes?$select=Name) before retrying; names are case- and space-insensitive in TM1."
}
```

A subset of high-signal tools (`tm1_set_cube_rules`, `tm1_upsert_process`, `tm1_execute_process`, `tm1_write_cells`, `tm1_execute_mdx`) attach a tool-context hint that names the right pre-flight or diagnose tool.
