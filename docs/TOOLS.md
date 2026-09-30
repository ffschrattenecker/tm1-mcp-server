<!-- The list between the TOOLS-AUTOGEN sentinels below is GENERATED from the
     source by scripts/gen-tool-list.mjs. Regenerate with
     `npm run tools:update-readme`; any hand edit inside the sentinels is
     overwritten without warning. Text outside them is hand-written and kept. -->

# Tool reference

Every tool this server can register, with the first sentence of the description
the model sees.

Two things the raw list does not show:

- **No single server exposes all of them.** `TM1_MODE=readonly` (the default)
  registers read tools only. `tm1_save_data` is v11-only.
- **Object CRUD goes through `tm1_rest_read` / `tm1_rest_write`**: any path
  relative to `/api/v1/`, narrowed with `$select`/`$filter`/`$top`. Collections
  include `}` control objects (`$filter=not startswith(Name,'}')`) and OData
  string comparison is case-sensitive (`tolower()`). The write tool refuses what
  a dedicated tool owns — process bodies, rules, cell writes, files, `$batch`,
  Execute actions — and names the tool to use.
- **Destructive tools require a `confirm` argument** that repeats the target
  name verbatim — `tm1_rest_write` (DELETE and cancel actions),
  `tm1_files_write`, `tm1_delete_elements`, `tm1_clear_cube`,
  `tm1_execute_process`, `tm1_execute_chore`, `tm1_write_cells`,
  `tm1_set_cube_rules`, and the create-or-update tools once the target exists.
  It is misuse protection against a mis-fired call, not
  access control.
- **With several connections, every tool takes `connection`**, and the comparison
  tools (`tm1_compare_environments`, `tm1_diff_cube_rules`, `tm1_diff_hierarchy`,
  `tm1_diff_processes`) also take an optional `connectionB` to compare against.
  Only read-only tools accept a second connection.

## Categories

| Category               | What it covers                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`             | list cubes / dimensions / processes / chores, hierarchy read, ancestors and descendants, default-member resolution                                                                                |
| `model-building`       | create/delete/clear/unload cube, get/set/check cube rules, bulk read of all rules, regex search across rules                                                                                      |
| `dimension-management` | dimension + hierarchy CRUD, element CRUD, bulk element upsert, element-attribute definitions and values                                                                                           |
| `subsets`              | list / get / create / update / delete subsets                                                                                                                                                     |
| `views`                | list views, create MDX or native (subset-based) view, delete view                                                                                                                                 |
| `celldata`             | execute MDX (with `format=markdown` pivot render), read a view, get a cell, write cells, sample cells, pre-write coordinate check (N-level + rule-overlap warning), feeder check and feeder trace |
| `ti-development`       | process CRUD and upsert, compile, unbound pre-save check, get/update code (single + bulk), datasource, variables, parameters, regex search across all TI, reference validation, process diff      |
| `scheduling`           | chore CRUD, execute now, activate/deactivate                                                                                                                                                      |
| `security`             | client and group CRUD, group assignment                                                                                                                                                           |
| `operations`           | server info and state, message / transaction / audit logs, error logs, threads (v11) or jobs (v12), sessions, save data (v11), cube stats                                                         |
| `fileops`              | list, search, read, upload and delete server-side files                                                                                                                                           |
| `analysis`             | process callgraph (tree, summary mode, global fan-in/fan-out ranking), object usage, chore graph, data-flow trace, naming / complexity / feeder audits, v12-readiness scan, orphan dimensions     |

The `.pro` and git round-trip tools (`tm1_import_pro_file`,
`tm1_export_process_to_pro`, `tm1_install_pro_bundle`,
`tm1_diff_process_with_file`, `tm1_export_process_to_git`,
`tm1_import_process_from_git`) live under `ti-development`; the `.pro` parser
handles tabs (572-575), parameters (560/561/590/637), variables (577-582) and
datasource (562-589).

<!-- TOOLS-AUTOGEN:START -->

## Tools (58)

### analysis (11)

- `tm1_analyze_callgraph` — Build a process call graph (ExecuteProcess/RunProcess) for a TI process
- `tm1_analyze_chore_graph` — Build downstream call graphs for every task of a TM1 chore
- `tm1_analyze_object_usage` — Find every reference to a cube or dimension across all TI processes (CellGet/Put, ViewExtract, ZeroOut, …) and cube rules (DB(), [dim].[el])
- `tm1_audit_complexity` — Bulk-scan TI processes and cube rules for complexity metrics (LOC, branches, max nesting, score)
- `tm1_audit_feeders` — Static heuristics (S1–S5) scan cube rules for overfeeding: wildcard brackets, feeders into consolidated
- `tm1_audit_naming` — Bulk-scan TM1 objects against IBM PA 2.0/3.1 naming conventions; reports hard violations only
- `tm1_check_v12_readiness` — Static gap-analysis against the TM1 / Planning Analytics v12 (Cloud Native) deprecation list
- `tm1_compare_environments` — Drift overview of connection vs connectionB (e.g
- `tm1_diff_cube_rules` — Diff a cube's rules across connections (connectionB) or against cubeB, as unified hunks; also compares the dimension lists and SKIPCHECK/FEEDERS presence.
- `tm1_diff_hierarchy` — Diff a hierarchy across connections (connectionB) or against dimensionB: elements, edges, weights, reparented children, attributes
- `tm1_trace_data_flow` — Trace data flow into and out of a cube in one call, instead of analyze_object_usage + N× get_process

### celldata (8)

- `tm1_check_feeders` — Check the feeders of a cell: verifies feeder coverage for the cells underlying this cell and returns the problematic ones with a fed flag — fed=false marks a br
- `tm1_check_writable_coords` — Pre-flight check before CellPutN/CellPutS
- `tm1_execute_mdx` — Execute an MDX query against the TM1 server and return structured cell data with axes (page envelope: total, count, offset, has_more, next_offset, items)
- `tm1_get_view` — Execute a named cube view and return structured cell data with axes (page-envelope shape consistent with tm1_execute_mdx)
- `tm1_sample_cells` — Return up to maxCells populated cells from a cube without guessing coordinates — builds a NON EMPTY CROSSJOIN MDX over the cube's dimensions and HEAD-limits it
- `tm1_trace_cell_calculation` — Trace how a cell value is calculated: recursive component tree with per-component type (Consolidation/Rule/Simple), status (Null/Data/Error), value, and the rul
- `tm1_trace_feeders` — Trace the feeders of a cell: returns the cells this cell feeds plus the feeder statements involved — answers 'which feeder statement fires from this cell, and w
- `tm1_write_cells` — Write one or more cell values directly to a TM1 cube via REST

### dimension-management (3)

- `tm1_bulk_upsert_elements` — Create or update multiple elements in a TM1 hierarchy in bulk (two-pass: leafs first, then consolidations)
- `tm1_delete_elements` — Delete many elements from one TM1 dimension hierarchy in a single call ($batch where the server supports it)
- `tm1_update_element_attribute_value` — Set attribute values on elements by writing to the }ElementAttributes_{Dim} control cube

### fileops (2)

- `tm1_files_read` — Read the TM1 server's file storage (TI data directory: Files on v12, Blobs on v11; auto-fallback)
- `tm1_files_write` — Change the TM1 server's file storage (TI data directory: Files on v12, Blobs on v11; auto-fallback)

### metadata (2)

- `tm1_list_processes_grouped` — Group TI processes by name prefix to give a structural overview without listing every process
- `tm1_resolve_default_members` — Resolve N hierarchies' effective default members in parallel from one tool call; pass items:[{dimensionName}] with a single entry for a one-off lookup

### model-building (6)

- `tm1_check_cube_rule` — Validate the syntax of a TM1 cube rule WITHOUT applying it
- `tm1_clear_cube` — Wipe every cell in a cube
- `tm1_get_all_cube_rules` — Bulk-load rules text for every cube in one call
- `tm1_get_cube_rules` — Get the current rules text for a TM1 cube
- `tm1_search_rules` — Regex search across cube rules text
- `tm1_set_cube_rules` — Create or replace the rules for a TM1 cube

### operations (7)

- `tm1_diagnose_process_error` — One-call error diagnosis for a failed TI process: lists matching error logs, fetches their content, and optionally includes cascade-related sibling logs (same t
- `tm1_get_cube_stats` — Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency)
- `tm1_get_error_log_content` — Fetch the raw text of one TI error log file produced by a failed process run
- `tm1_get_server_state` — Health-check style snapshot of the TM1 server in one call
- `tm1_list_connections` — List the TM1 connections this server can reach: name (the `connection` argument of every other tool), readonly/readwrite mode, TM1_ENVIRONMENT label (and why mo
- `tm1_list_error_logs` — List TI process error log files on the TM1 server, newest first
- `tm1_save_data` — Persist in-memory cube data to disk: SaveDataAll (all cubes) or CubeSaveData when `cube` is given

### rest (2)

- `tm1_rest_read` — GET any TM1 REST path (relative to /api/v1/), plus POST Processes('P')/tm1.Compile
- `tm1_rest_write` — POST/PATCH/PUT/DELETE a TM1 REST path (relative to /api/v1/), e.g

### scheduling (2)

- `tm1_execute_chore` — Execute a TM1 chore immediately, bypassing its schedule
- `tm1_update_chore` — Update an existing TM1 chore

### ti-development (15)

- `tm1_check_process_code` — Validate TI process code WITHOUT saving it on the server (POST /api/v1/CompileProcess unbound)
- `tm1_copy_process` — Copy a TI process to a new name
- `tm1_diff_process_with_file` — Compare an installed TI process on the server against a local .pro file
- `tm1_diff_processes` — Compare two installed TI processes tab-by-tab (Prolog/Metadata/Data/Epilog), on one connection or across two (connectionB, e.g
- `tm1_execute_process` — Execute a TurboIntegrator process on the TM1 server with optional parameters
- `tm1_export_process_to_git` — Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' (parameters, variables, ignored datasource columns, datasource) plus a '{name}.ti' (Prol
- `tm1_export_process_to_pro` — Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body
- `tm1_get_all_processes_code` — Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call, plus each process's HasSecurityAccess elevation flag (hasSecurityAccess) fo
- `tm1_get_process` — Native full read of a TI process — the read-twin of tm1_upsert_process
- `tm1_import_pro_file` — Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call
- `tm1_import_process_from_git` — Deploy a TM1 process from the tm1-git two-file layout ('{name}.json' + '{name}.ti')
- `tm1_install_pro_bundle` — Install all .pro files from a directory in one call
- `tm1_search_code` — Regex search across all TI process code (Prolog/Metadata/Data/Epilog)
- `tm1_upsert_process` — Atomic-style create-or-update for a TI process
- `tm1_validate_process_refs` — Scan a TI process (live, by name, or from .pro) for cube/dimension references in well-known TI functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementIn

<!-- TOOLS-AUTOGEN:END -->
