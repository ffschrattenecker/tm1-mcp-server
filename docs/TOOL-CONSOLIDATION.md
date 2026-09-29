# Tool consolidation: keep / delete

Decided 2026-09-30. The server had 114 defined tools (112 exposed on v11; `tm1_list_jobs` / `tm1_cancel_job` are
v12-only). Many were one REST call wrapped in a schema. They are replaced by two guarded generic tools,
`tm1_rest_read` and `tm1_rest_write`. Only tools that add logic a model cannot reproduce in one call are kept.
The server has one user (Claude Code), so no compatibility shims.

## Criteria

**Keep** a tool if it does at least one of:

- parses or analyses TI / rules code (callgraph, refs, complexity, rule outline/patch)
- joins several endpoints or cubes into one answer the model would otherwise assemble over many calls
- shapes a large payload into a compact one (cellsets, rule sections, log tails)
- carries a safety net beyond "confirm before delete" (backup, preflight, compile-and-rollback, never-retry)
- handles a long-running or binary operation (heartbeat, timeout, bytes)

**Delete** a tool if it maps to one OData request that the REST tools can issue with `$select` / `$filter` /
`$expand` / `$top`, and its only extra is pagination, a projection, or `confirm`.

**Merge** where a tool's one useful piece belongs in another tool.

## `tm1_rest_read` / `tm1_rest_write` (new)

Two tools, not one: the per-call readonly gate in `define-tool.ts` compares a tool's static `readOnlyHint` with
the connection's mode, and readonly mode drops non-readonly tools at registration. A single tool with a
`method` argument could not be gated. The split also maps onto Claude Code's permission prompts.

```
tm1_rest_read({ connection, path, maxChars? })                        // READ_ONLY
tm1_rest_write({ connection, method: POST|PATCH|PUT|DELETE, path, body?, confirm?, timeoutMs? })  // DESTRUCTIVE
```

- `path` is relative to `/api/v1/` (e.g. `Dimensions('Region')/Hierarchies('Region')/Elements?$select=Name,Type&$top=50`).
- `tm1_rest_read` issues `GET`, plus exactly one read-only `POST`: `Processes('P')/tm1.Compile`
  (replaces the READ_ONLY `tm1_compile_process`, so compile stays available on readonly connections).
- Reuses the existing HTTP layer: connection resolution, keychain credentials, session reuse, 401 stop,
  `TM1Error` hints, "outcome unknown, do not re-run" on dropped long calls. Non-GET requests are never retried.
- `DELETE` and cancel actions (`tm1.CancelOperation`, `tm1.Cancel`) require `confirm` = the last key in the path
  (the object being deleted / cancelled), like `requireConfirm` today.
- Path handling: percent-decode and compare case-insensitively before matching; reject absolute URLs,
  a leading `/api/`, `..`, backslashes and control characters.
- No bypass of kept tools. `tm1_rest_write` rejects these and names the tool to use instead:
  - any `POST`/`PATCH`/`PUT` on `Processes` or under `Processes(...)` (except `tm1.Compile`, which is a read)
    → `tm1_upsert_process` (preflight, backup, rollback). `DELETE Processes('P')` stays allowed (confirm).
  - `ExecuteProcessWithReturn`, `ExecuteProcess`, any `tm1.Execute*` on processes, `tm1.Execute` on chores
    → `tm1_execute_process` / `tm1_execute_chore`. The unbound action with an inline `Process` body runs arbitrary TI.
  - `PATCH`/`PUT` on `Cubes(...)` whose body has `Rules`, and any write to `Cubes(...)/Rules` → `tm1_set_cube_rules`
  - any `Cellsets` write, `tm1.Update`, `tm1.UpdateCells` → `tm1_write_cells`
  - `ExecuteMDX`, `ExecuteMDXSetExpression`, `ExecuteView` and other `Cellsets` reads → `tm1_execute_mdx` / `tm1_get_view`
  - `$batch` (its inner requests would pass the path checks unseen)
  - `tm1.SaveDataAll` / `tm1.SaveData` / `tm1.Clear` → `tm1_save_data` / `tm1_clear_cube`
  - `Contents`/`Files`/`Blobs` writes → `tm1_files_write`
- Response: strip `@odata.*` keys, mask secrets (`maskSecretsDeep`), and truncate to a character budget
  (`maxChars`, default well under the 80k response guard) with `truncated: true` and the item count kept vs
  returned — the response guard refuses oversize payloads outright, so the tool must truncate itself.
- Description holds a short endpoint cheat sheet. The four skills get a longer one.

## Files: 5 → 2

`tm1_files_read({ op: list|search|get, ... })` (READ_ONLY) and `tm1_files_write({ op: upload|delete, ... })`
(DESTRUCTIVE). Two tools for the same readonly-gate reason. They keep the Applications container resolution,
byte handling and base64 limits of the current tools.

## Keep (59)

| Tool                                                                            | Why                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Analysis**                                                                    |                                                                                   |
| tm1_analyze_callgraph                                                           | TI parser + reference index; nothing in REST                                      |
| tm1_analyze_chore_graph                                                         | chore → process → callgraph join                                                  |
| tm1_analyze_object_usage                                                        | cross-object reference index; absorbs delete impact (see Merge)                   |
| tm1_audit_complexity                                                            | process metrics + antipatterns                                                    |
| tm1_audit_feeders                                                               | rule/feeder analysis                                                              |
| tm1_audit_naming                                                                | naming rules across all object types                                              |
| tm1_check_v12_readiness                                                         | deprecated-TI catalogue                                                           |
| tm1_compare_environments                                                        | multi-connection diff                                                             |
| tm1_diff_cube_rules                                                             | line diff, optionally cross-connection                                            |
| tm1_diff_hierarchy                                                              | hierarchy diff                                                                    |
| tm1_trace_data_flow                                                             | TI data-flow analysis                                                             |
| **Cells**                                                                       |                                                                                   |
| tm1_execute_mdx                                                                 | cellset → compact rows; replaces tm1_get_cell_value too                           |
| tm1_get_view                                                                    | cellset shaping + axis clipping                                                   |
| tm1_sample_cells                                                                | sampling logic                                                                    |
| tm1_write_cells                                                                 | coordinate validation, cellset writeback                                          |
| tm1_check_writable_coords                                                       | rule/consolidation/type checks per coordinate                                     |
| tm1_trace_cell_calculation                                                      | rule tracing                                                                      |
| tm1_check_feeders                                                               | CheckFeeders action + fed/consolidation fix                                       |
| tm1_trace_feeders                                                               | feeder tracing                                                                    |
| **Rules**                                                                       |                                                                                   |
| tm1_get_cube_rules                                                              | outline, line ranges                                                              |
| tm1_get_all_cube_rules                                                          | multi-cube with projections                                                       |
| tm1_search_rules                                                                | regex across all rules                                                            |
| tm1_set_cube_rules                                                              | patch, read-in-full loop, check                                                   |
| tm1_check_cube_rule                                                             | rule check action with located errors                                             |
| **Processes**                                                                   |                                                                                   |
| tm1_get_process                                                                 | parts projection, comment stripping                                               |
| tm1_get_all_processes_code                                                      | bulk code with projections                                                        |
| tm1_search_code                                                                 | regex across all TI code                                                          |
| tm1_check_process_code                                                          | static checks                                                                     |
| tm1_validate_process_refs                                                       | refs against live objects                                                         |
| tm1_upsert_process                                                              | preflight, backup, compile, rollback                                              |
| tm1_execute_process                                                             | heartbeat, timeout, error-log pickup, never-retry                                 |
| tm1_diagnose_process_error                                                      | error log + code correlation                                                      |
| tm1_diff_processes                                                              | line diff, cross-connection                                                       |
| tm1_diff_process_with_file                                                      | diff vs .pro / git file                                                           |
| tm1_export_process_to_pro                                                       | .pro serializer                                                                   |
| tm1_export_process_to_git                                                       | tm1-git format                                                                    |
| tm1_import_pro_file                                                             | .pro parser, local file                                                           |
| tm1_import_process_from_git                                                     | tm1-git format                                                                    |
| tm1_install_pro_bundle                                                          | multi-file install                                                                |
| **Elements**                                                                    |                                                                                   |
| tm1_delete_elements                                                             | `$batch` with per-element results; falls back when batch unsupported              |
| tm1_bulk_upsert_elements                                                        | batching, edges, weights in one call                                              |
| tm1_update_element_attribute_value                                              | writes via `}ElementAttributes_` cube, batch                                      |
| **Metadata**                                                                    |                                                                                   |
| tm1_resolve_default_members                                                     | DefaultMember, then fallback tiers when none is defined                           |
| **Cube lifecycle**                                                              |                                                                                   |
| tm1_clear_cube                                                                  | runs a temporary TI (no REST clear action); timeout                               |
| tm1_save_data                                                                   | runs a temporary TI (`SaveDataAll` / `CubeSaveData`); heartbeat, timeout          |
| **Processes (guards)**                                                          |                                                                                   |
| tm1_copy_process                                                                | never-overwrite guard; GET + POST                                                 |
| tm1_list_processes_grouped                                                      | prefix grouping (kept: skills carry no workarounds)                               |
| **Chores**                                                                      |                                                                                   |
| tm1_update_chore                                                                | missing-offset → `Z` coercion of `startTime` (kept, same reason)                  |
| tm1_execute_chore                                                               | heartbeat, timeout, never-retry                                                   |
| **Files** → merged into `tm1_files_read` / `tm1_files_write` (see Files: 5 → 2) |                                                                                   |
| tm1_list_files                                                                  |                                                                                   |
| tm1_search_files                                                                |                                                                                   |
| tm1_get_file_content                                                            | bytes / text decode                                                               |
| tm1_upload_file                                                                 | binary upload                                                                     |
| tm1_delete_file                                                                 |                                                                                   |
| **Server**                                                                      |                                                                                   |
| tm1_list_connections                                                            | local config, no REST                                                             |
| tm1_get_cube_stats                                                              | `}StatsByCube` + concurrency                                                      |
| tm1_get_server_state                                                            | joins six endpoints into one snapshot                                             |
| tm1_list_error_logs                                                             | `ErrorLogFiles` has only `Filename`; process-name and timestamp matching parse it |
| tm1_get_error_log_content                                                       | tail / grep of raw log text                                                       |

## Merge (3)

| Tool                           | Into                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| tm1_invalidate_callgraph_cache | `refresh: true` flag on tm1_analyze_callgraph                               |
| tm1_delete_dimension           | its `dryRun` impact → tm1_analyze_object_usage; the delete → tm1_rest_write |
| tm1_delete_cube                | same as tm1_delete_dimension                                                |

## Delete (52)

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

Totals: keep 59 (the 5 file tools become 2) + `tm1_rest_read` + `tm1_rest_write` = 58 exposed tools on v11; merge 3; delete 52.

## Decisions (2026-09-30)

1. Only Claude Code uses the server: no compatibility shims, no deprecation window.
2. `tm1_list_cubes` / `tm1_list_dimensions` / `tm1_get_hierarchy` are the most-called orientation tools
   (92 / 52 / 197 calls across 237 local session logs). They are deleted only if a live like-for-like
   comparison against plapp-franz (response characters and calls for the same information) shows the REST
   tool is not worse. Result: deleted (see "Comparison").
3. `tm1_create_native_view`: 0 calls in the session logs, only a live test and an EXAMPLES.md entry. Deleted.
4. File tools: merged, 5 → 2 (two, not one, because of the readonly gate).
5. `tm1_update_chore` and `tm1_list_processes_grouped` are kept; their logic does not move into skill prose.

## Comparison (live, plapp-franz 11.8.03500.4, 2026-09-30)

Replayed the argument shapes most used in the session logs. Characters are the response text the model reads.
Tool definition cost (loaded once per session via tool search): `tm1_list_cubes` 2,576 + `tm1_list_dimensions`
3,511 + `tm1_get_hierarchy` 3,979 = 10,066 chars, vs `tm1_rest_read` 1,677.

| Scenario                                                                  | Old tool                               | `tm1_rest_read`                                                      |
| ------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| cubes, all non-control                                                    | 190                                    | 150 (`$filter=not startswith(Name,'}')`)                             |
| dimensions + hierarchies, non-control (44)                                | 2,472                                  | 2,844                                                                |
| dimensions + element counts                                               | 4,032                                  | 3,602 (`Hierarchies($select=Name,Cardinality)`)                      |
| hierarchy, 145 elements, default (type, level, parents, children+weights) | 15,882                                 | 10,793 with `Parents`; 6,736 + 8,516 as elements + `Edges`           |
| hierarchy, `compact` (no edges)                                           | 6,813                                  | 6,736                                                                |
| hierarchy, 95 elements, `topN:10000`                                      | 10,167                                 | 6,902                                                                |
| element count of a 160k-element dimension                                 | 234 (byType/byLevel)                   | 49 (`?$select=Cardinality`); a level split is one `$count` call each |
| 10k elements of a 160k-element dimension                                  | error: RESPONSE_TOO_LARGE (749k chars) | 30k chars, `truncated:true` with kept/total                          |

Same number of calls in every case except the per-type/level count split. The REST tool is smaller or equal
everywhere except the dimension list (+15%, it keeps `Sandboxes` and TM1's key casing), and it degrades by
truncating where `tm1_get_hierarchy` refused outright. Traps to put in the skills cheat sheet: the old tools
hid control objects by default (the REST filter must say `not startswith(Name,'}')`), and name filters need
`tolower()` to be case-insensitive. Decision: delete all three.

## Migration work

- `withToolHint` / error hints and `server-instructions.ts` reference deleted tool names; point them at
  the REST tools or the replacing tool.
- `docs/TOOLS.md`, `README.md`, `evals/`, prompts and resources.
- Unit tests and recorded contracts for deleted tools go; add tests for the REST tools (guard, confirm,
  compaction, truncation, masking).
- spms-tools `tm1-mcp` plugin: the four skills name the deleted tools; add the endpoint cheat sheet;
  `tm1-api` stops being a fallback and becomes the reference for the REST tools paths.
- Major version bump (9.0.0).

## Status (handoff, 2026-09-30)

Paused mid-way on branch `feat/tool-consolidation` (not pushed). Paired branch `feat/tool-consolidation` in
spms-tools exists but has no commits yet.

Done:

- Spec, decisions and live comparison (this file).
- Built: `tm1_rest_read` / `tm1_rest_write` (`src/tools/rest/`, `src/tm1-client/services/rest-service.ts`),
  `tm1_files_read` / `tm1_files_write`, `refresh` on `tm1_analyze_callgraph`, `usedInCubes` on
  `tm1_analyze_object_usage`. The REST guard survived three red-team rounds; unit tests pass for all of it.
- Deleted: the 60 tools (commit `4c44692`) and `delete-impact.ts`. `npm run typecheck`,
  `lint:tool-registration` and `lint:output-schema-budget` (38.7 KB, 60%) pass.

Left to do, in this order:

1. **Unit tests** (red now). Typecheck fails in 12 files that imported deleted tools
   (`monitoring-tools-registration`, `odata-pushdown`, `hierarchy-default`, `rest-tools`, `delete-dry-run`,
   `slim-json-schema`, `output-schema-roundtrip`, `get-server-info-masking`, `get-hierarchy-tool`,
   `get-file-content-base64`, `get-descendants-tool`, `element-attribute-values-page`). Runtime failures in the
   shared lists: `output-schema-map`, `output-schema-additional-properties`, `confirm-coverage`,
   `markdown-structured`, `tool-registration`, `annotation-requires-version`. Delete handler-only tests; keep any
   service-layer assertions; repoint shared lists to the surviving tools.
2. **Stale names in `src/`**: hints, descriptions, `server-instructions.ts`, prompts, resources, services
   (e.g. `file-service.ts` hint names `tm1_list_files`), `http.ts` hints naming `tm1_list_threads`/`tm1_list_jobs`.
   Remove now-dead schemas in `src/tools/schemas/items-*.ts` and empty category comments in `src/tools/index.ts`.
   Service methods left unused by tools: list them, decide separately.
3. **Live tests** (`tests/live/`): rewrite setup/teardown that used deleted tools to the REST tools; delete tests
   of deleted tools; add `rest.live.test.ts`. Run only via `npm run test:live:for -- tm1-plapp-franz`.
4. **Docs**: `npm run tools:list` / `tools:update-readme`, `docs/EXAMPLES.md`, `ARCHITECTURE.md`, `evals/`,
   CHANGELOG 9.0.0 entry.
5. **spms-tools skills**: route CRUD to the REST tools with one shared endpoint cheat sheet (include the
   control-object and `tolower()` traps); repurpose `tm1-api` so it no longer competes with `tm1_rest_read`;
   major plugin version bump paired with server 9.0.0.
6. **Verify**: all gates in `npm run verify` except `lint:format` (run prettier on changed files only), the
   coverage ratchet, and a word-grep for every deleted name (allowed only in CHANGELOG and this file).
7. Bump `package.json` to 9.0.0. No tag / push / publish until asked.

Known follow-ups from the build: `responseLimit()` in `src/tools/rest/shape.ts` reads `TM1_MAX_RESPONSE_CHARS`
from env rather than the value passed to `withAnnotations()`; the secret-name check refuses `$filter`/`$orderby`
on properties whose names contain `pass`/`auth`/`token`; a doubly-encoded `%XX` path is refused by design.

The cleanup workflow script (steps 1–6 as parallel agents + verify loop) is saved at
`~/.claude/projects/C--Users-franz-schrattenecker-repos-tm1-mcp-server/9215c3ef-2a08-45ea-8964-ad9d13e902a2/workflows/scripts/consolidation-cleanup-wf_1186b4a6-1d7.js`;
none of its agents finished, so rerun it fresh.
