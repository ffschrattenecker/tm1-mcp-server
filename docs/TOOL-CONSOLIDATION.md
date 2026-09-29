# Tool consolidation: keep / delete

Draft, 2026-09-29. The server has 114 defined tools (112 exposed on v11; `tm1_list_jobs` / `tm1_cancel_job` are v12-only).
Many of them are one REST call wrapped in a schema. This document proposes replacing those with one guarded
generic tool, `tm1_request`, and keeping only tools that add logic a model cannot reproduce in one call.

## Criteria

**Keep** a tool if it does at least one of:

- parses or analyses TI / rules code (callgraph, refs, complexity, rule outline/patch)
- joins several endpoints or cubes into one answer the model would otherwise assemble over many calls
- shapes a large payload into a compact one (cellsets, rule sections, log tails)
- carries a safety net beyond "confirm before delete" (backup, preflight, compile-and-rollback, never-retry)
- handles a long-running or binary operation (heartbeat, timeout, bytes)

**Delete** a tool if it maps to one OData request that `tm1_request` can issue with `$select` / `$filter` /
`$expand` / `$top`, and its only extra is pagination, a projection, or `confirm`.

**Merge** where a tool's one useful piece belongs in another tool.

## `tm1_request` (new)

```
tm1_request({ connection, method: GET|POST|PATCH|PUT|DELETE, path, body?, confirm?, timeoutMs?, maxItems? })
```

- `path` is relative to `/api/v1/` (e.g. `Dimensions('Region')/Hierarchies('Region')/Elements?$select=Name,Type&$top=50`).
- Reuses the existing HTTP layer: connection resolution, keychain credentials, session reuse, 401 stop,
  `TM1Error` hints, "outcome unknown, do not re-run" on dropped long calls.
- Writes (`POST`/`PATCH`/`PUT`/`DELETE`) obey the write guard: only on a connection the user named.
  `DELETE` and cancel actions (`tm1.CancelOperation`, `tm1.Cancel`) require `confirm` = the target object
  name taken from the path, like `requireConfirm` today.
- Non-GET requests are never retried.
- No bypass of kept tools. `tm1_request` rejects these and names the tool to use instead:
  - `PATCH`/`POST`/`PUT` on `Processes(...)` or `POST Processes` → `tm1_upsert_process` (preflight, backup, rollback);
    `POST Processes(...)/tm1.Compile` stays allowed
  - `PATCH Cubes('C')` touching `Rules` → `tm1_set_cube_rules`
  - any `Cellsets(...)` write, `tm1.Update`, `tm1.UpdateCells` → `tm1_write_cells`
  - `tm1.Execute*` on processes, `ExecuteProcessWithReturn`, `tm1.Execute` on chores → `tm1_execute_process` / `tm1_execute_chore`
  - `ExecuteMDX` / `Cellsets` reads → `tm1_execute_mdx` (compaction, cellset cleanup)
- Response: strip `@odata.*` keys, cap `value[]` at `maxItems` (default 100) with `truncated` + `total` when
  `$count` is present, mask secrets (`maskSecretsDeep`).
- Description holds a short endpoint cheat sheet. The four skills get a longer one.

## Keep (57)

| Tool                                                                                         | Why                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Analysis**                                                                                 |                                                                                   |
| tm1_analyze_callgraph                                                                        | TI parser + reference index; nothing in REST                                      |
| tm1_analyze_chore_graph                                                                      | chore → process → callgraph join                                                  |
| tm1_analyze_object_usage                                                                     | cross-object reference index; absorbs delete impact (see Merge)                   |
| tm1_audit_complexity                                                                         | process metrics + antipatterns                                                    |
| tm1_audit_feeders                                                                            | rule/feeder analysis                                                              |
| tm1_audit_naming                                                                             | naming rules across all object types                                              |
| tm1_check_v12_readiness                                                                      | deprecated-TI catalogue                                                           |
| tm1_compare_environments                                                                     | multi-connection diff                                                             |
| tm1_diff_cube_rules                                                                          | line diff, optionally cross-connection                                            |
| tm1_diff_hierarchy                                                                           | hierarchy diff                                                                    |
| tm1_trace_data_flow                                                                          | TI data-flow analysis                                                             |
| **Cells**                                                                                    |                                                                                   |
| tm1_execute_mdx                                                                              | cellset → compact rows; replaces tm1_get_cell_value too                           |
| tm1_get_view                                                                                 | cellset shaping + axis clipping                                                   |
| tm1_sample_cells                                                                             | sampling logic                                                                    |
| tm1_write_cells                                                                              | coordinate validation, cellset writeback                                          |
| tm1_check_writable_coords                                                                    | rule/consolidation/type checks per coordinate                                     |
| tm1_trace_cell_calculation                                                                   | rule tracing                                                                      |
| tm1_check_feeders                                                                            | CheckFeeders action + fed/consolidation fix                                       |
| tm1_trace_feeders                                                                            | feeder tracing                                                                    |
| **Rules**                                                                                    |                                                                                   |
| tm1_get_cube_rules                                                                           | outline, line ranges                                                              |
| tm1_get_all_cube_rules                                                                       | multi-cube with projections                                                       |
| tm1_search_rules                                                                             | regex across all rules                                                            |
| tm1_set_cube_rules                                                                           | patch, read-in-full loop, check                                                   |
| tm1_check_cube_rule                                                                          | rule check action with located errors                                             |
| **Processes**                                                                                |                                                                                   |
| tm1_get_process                                                                              | parts projection, comment stripping                                               |
| tm1_get_all_processes_code                                                                   | bulk code with projections                                                        |
| tm1_search_code                                                                              | regex across all TI code                                                          |
| tm1_check_process_code                                                                       | static checks                                                                     |
| tm1_validate_process_refs                                                                    | refs against live objects                                                         |
| tm1_upsert_process                                                                           | preflight, backup, compile, rollback                                              |
| tm1_execute_process                                                                          | heartbeat, timeout, error-log pickup, never-retry                                 |
| tm1_diagnose_process_error                                                                   | error log + code correlation                                                      |
| tm1_diff_processes                                                                           | line diff, cross-connection                                                       |
| tm1_diff_process_with_file                                                                   | diff vs .pro / git file                                                           |
| tm1_export_process_to_pro                                                                    | .pro serializer                                                                   |
| tm1_export_process_to_git                                                                    | tm1-git format                                                                    |
| tm1_import_pro_file                                                                          | .pro parser, local file                                                           |
| tm1_import_process_from_git                                                                  | tm1-git format                                                                    |
| tm1_install_pro_bundle                                                                       | multi-file install                                                                |
| **Elements**                                                                                 |                                                                                   |
| tm1_delete_elements                                                                          | `$batch` with per-element results; falls back when batch unsupported              |
| tm1_bulk_upsert_elements                                                                     | batching, edges, weights in one call                                              |
| tm1_update_element_attribute_value                                                           | writes via `}ElementAttributes_` cube, batch                                      |
| **Metadata**                                                                                 |                                                                                   |
| tm1_resolve_default_members                                                                  | DefaultMember, then fallback tiers when none is defined                           |
| **Cube lifecycle**                                                                           |                                                                                   |
| tm1_clear_cube                                                                               | runs a temporary TI (no REST clear action); timeout                               |
| tm1_save_data                                                                                | runs a temporary TI (`SaveDataAll` / `CubeSaveData`); heartbeat, timeout          |
| **Processes (guards)**                                                                       |                                                                                   |
| tm1_copy_process                                                                             | never-overwrite guard; GET + POST                                                 |
| **Chores**                                                                                   |                                                                                   |
| tm1_execute_chore                                                                            | heartbeat, timeout, never-retry                                                   |
| **Files** (Applications container resolution + bytes; revisit later as one `tm1_files` tool) |                                                                                   |
| tm1_list_files                                                                               |                                                                                   |
| tm1_search_files                                                                             |                                                                                   |
| tm1_get_file_content                                                                         | bytes / text decode                                                               |
| tm1_upload_file                                                                              | binary upload                                                                     |
| tm1_delete_file                                                                              |                                                                                   |
| **Server**                                                                                   |                                                                                   |
| tm1_list_connections                                                                         | local config, no REST                                                             |
| tm1_get_cube_stats                                                                           | `}StatsByCube` + concurrency                                                      |
| tm1_get_server_state                                                                         | joins six endpoints into one snapshot                                             |
| tm1_list_error_logs                                                                          | `ErrorLogFiles` has only `Filename`; process-name and timestamp matching parse it |
| tm1_get_error_log_content                                                                    | tail / grep of raw log text                                                       |

## Merge (3)

| Tool                           | Into                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| tm1_invalidate_callgraph_cache | `refresh: true` flag on tm1_analyze_callgraph                            |
| tm1_delete_dimension           | its `dryRun` impact → tm1_analyze_object_usage; the delete → tm1_request |
| tm1_delete_cube                | same as tm1_delete_dimension                                             |

## Delete (54)

Each row lists the replacing request. Paths are taken from the service methods in `src/tm1-client/services/`.

| Tool                             | Replacement                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Metadata**                     |                                                                                                           |
| tm1_list_cubes                   | `GET Cubes?$select=Name&$filter=contains(tolower(Name),'x')&$expand=Dimensions($select=Name)`             |
| tm1_list_dimensions              | `GET Dimensions?$select=Name&$filter=...`                                                                 |
| tm1_get_hierarchy                | `GET Dimensions('D')/Hierarchies('H')?$expand=Elements($select=Name,Type;$top=50)` (+ `/Elements/$count`) |
| tm1_get_ancestors                | `tm1_execute_mdx` with `ANCESTORS` / `GENERATE(...)`, or `Elements('e')/Parents`                          |
| tm1_get_descendants              | `tm1_execute_mdx` with `DESCENDANTS` / `TM1FILTERBYLEVEL`                                                 |
| tm1_list_processes               | `GET Processes?$select=Name&$filter=...`                                                                  |
| tm1_list_processes_grouped       | same; the model groups by prefix (open question 5)                                                        |
| tm1_list_chores                  | `GET Chores?$select=Name,Active,StartTime,Frequency&$expand=Tasks($expand=Process($select=Name))`         |
| **Cells / views**                |                                                                                                           |
| tm1_get_cell_value               | `tm1_execute_mdx`                                                                                         |
| tm1_get_view_definition          | `GET Cubes('C')/Views('V')?$expand=*`                                                                     |
| tm1_list_views                   | `GET Cubes('C')/Views?$select=Name` (+ `PrivateViews`)                                                    |
| tm1_create_mdx_view              | `POST Cubes('C')/Views` with `MDXView` body                                                               |
| tm1_create_native_view           | `POST Cubes('C')/Views` with `NativeView` body (verbose; worth a skill example)                           |
| tm1_delete_view                  | `DELETE Cubes('C')/Views('V')`                                                                            |
| **Cube lifecycle**               |                                                                                                           |
| tm1_create_cube                  | `POST Cubes`                                                                                              |
| tm1_unload_cube                  | `POST Cubes('C')/tm1.Unload`                                                                              |
| **Dimensions / elements**        |                                                                                                           |
| tm1_create_dimension             | `POST Dimensions`                                                                                         |
| tm1_create_hierarchy             | `POST Dimensions('D')/Hierarchies`                                                                        |
| tm1_delete_hierarchy             | `DELETE Dimensions('D')/Hierarchies('H')`                                                                 |
| tm1_create_element               | `POST .../Elements` (+ `Edges` for parent)                                                                |
| tm1_update_element               | `PATCH .../Elements('e')`                                                                                 |
| tm1_delete_element               | `DELETE .../Elements('e')`                                                                                |
| tm1_list_element_attributes      | `GET .../ElementAttributes`                                                                               |
| tm1_create_element_attribute     | `POST .../ElementAttributes`                                                                              |
| tm1_get_element_attribute_values | `GET .../Elements?$select=Name,Attributes/Caption`                                                        |
| **Subsets**                      |                                                                                                           |
| tm1_list_subsets                 | `GET .../Subsets?$select=Name,Expression`                                                                 |
| tm1_get_subset                   | `GET .../Subsets('S')?$expand=Elements($select=Name)`                                                     |
| tm1_create_subset                | `POST .../Subsets`                                                                                        |
| tm1_update_subset                | `PATCH .../Subsets('S')`                                                                                  |
| tm1_delete_subset                | `DELETE .../Subsets('S')`                                                                                 |
| **Chores**                       |                                                                                                           |
| tm1_create_chore                 | `POST Chores`                                                                                             |
| tm1_update_chore                 | `PATCH Chores('X')` (drops the missing-offset → `Z` coercion; open question 5)                            |
| tm1_toggle_chore                 | `PATCH Chores('X')` with `{ Active }`                                                                     |
| tm1_delete_chore                 | `DELETE Chores('X')`                                                                                      |
| **Processes**                    |                                                                                                           |
| tm1_compile_process              | `POST Processes('P')/tm1.Compile`                                                                         |
| tm1_delete_process               | `DELETE Processes('P')`                                                                                   |
| **Security**                     |                                                                                                           |
| tm1_list_clients                 | `GET Users?$select=Name,Type&$expand=Groups($select=Name)`                                                |
| tm1_get_client                   | `GET Users('u')?$expand=Groups`                                                                           |
| tm1_create_client                | `POST Users`                                                                                              |
| tm1_update_client                | `PATCH Users('u')`                                                                                        |
| tm1_delete_client                | `DELETE Users('u')`                                                                                       |
| tm1_assign_client_group          | `PATCH Users('u')` with `Groups@odata.bind`                                                               |
| tm1_remove_client_group          | `DELETE Users('u')/Groups?$id=Groups('g')`                                                                |
| tm1_list_groups                  | `GET Groups?$expand=Users($select=Name)`                                                                  |
| **Server / monitoring**          |                                                                                                           |
| tm1_get_server_info              | `GET Configuration`, `GET ActiveConfiguration` (masked)                                                   |
| tm1_list_sessions                | `GET Sessions?$expand=User($select=Name),Threads`                                                         |
| tm1_list_threads                 | `GET Threads`                                                                                             |
| tm1_cancel_thread                | `POST Threads(id)/tm1.CancelOperation` (confirm)                                                          |
| tm1_list_jobs                    | `GET Jobs?$expand=Session,WaitingOn` (v12)                                                                |
| tm1_cancel_job                   | `POST Jobs('id')/tm1.Cancel` (v12, confirm)                                                               |
| tm1_get_message_log              | `GET MessageLogEntries?$filter=...&$orderby=TimeStamp desc&$top=n`                                        |
| tm1_get_audit_log                | `GET AuditLogEntries?$filter=...`                                                                         |
| tm1_get_transaction_log          | `GET TransactionLogEntries?$filter=...`                                                                   |
| **Analysis**                     |                                                                                                           |
| tm1_find_orphan_dimensions       | `GET Dimensions` + `GET Cubes?$expand=Dimensions`, set difference                                         |

Totals: keep 57 + `tm1_request` = 58 exposed tools; merge 3; delete 54.

## Open questions

1. Are there non-Claude-Code clients (older models, no tool search) using the npm package? They lose the
   named CRUD tools and must write OData.
2. `tm1_list_cubes` / `tm1_list_dimensions` / `tm1_get_hierarchy` are the most-called orientation tools.
   Deleting them is the right call for Claude, but measure first: for a sample of tasks, compare tokens and
   turns between the named tool and `tm1_request`.
3. `tm1_create_native_view` has a verbose body. Keep it if Claude gets it wrong via `tm1_request`.
4. File tools: fold into one `tm1_files({ op })` or leave as they are.
5. Two deletions push small logic into skill prose: `tm1_update_chore`'s missing-offset → `Z` coercion and
   `tm1_list_processes_grouped`'s prefix grouping. Skills should not carry workarounds; either keep the
   tools or accept that the logic is gone.

## Migration work

- `withToolHint` / error hints and `server-instructions.ts` reference deleted tool names; point them at
  `tm1_request` or the replacing tool.
- `docs/TOOLS.md`, `README.md`, `evals/`, prompts and resources.
- Unit tests and recorded contracts for deleted tools go; add tests for `tm1_request` (guard, confirm,
  compaction, truncation, masking).
- spms-tools `tm1-mcp` plugin: the four skills name the deleted tools; add the endpoint cheat sheet;
  `tm1-api` stops being a fallback and becomes the reference for `tm1_request` paths.
- Major version bump (9.0.0).
