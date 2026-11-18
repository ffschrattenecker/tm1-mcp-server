# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [11.0.0] - 2026-11-18

### Added

- **`tm1_files_write` op='create_folder'** creates one folder level per call; an existing folder answers `created=false`. `container='applications'` works on v11 and v12; `files` nests on v12 only, and v11 answers `UNSUPPORTED_OPERATION`.
- **Binary files move by host path.** `tm1_files_write` upload takes `sourcePath` and sends that file byte-for-byte; `tm1_files_read` get takes `writeToFile` and saves the whole file untruncated, answering with path, size and SHA-256. Both follow `TM1_LOCAL_FILE_ROOT`. A spreadsheet as base64 was too long for a model to copy reliably.
- **Every upload is read back and compared by SHA-256** (`sha256`, `verified`). A failed read-back leaves the upload standing and reports `verified=false`.

### Changed

- **BREAKING: an upload to `container='applications'` refuses a document that already exists** (`CONFLICT`) unless `overwrite=true` is passed. The `files` container replaces as before.

- **A timed-out MDX or view read is cancelled on the server.** TM1 finishes a request it has received whatever the client does, so a query that ran into the client timeout kept its thread busy (observed: 30 minutes). Cellset reads and view executions now run as an async operation (`Prefer: respond-async`) and are `DELETE`d when they time out or the client aborts; the `LOCK_TIMEOUT` error carries `cancelled: true|false`. 11.8 stops the work within milliseconds; v12 accepts the cancel but may still finish a scan, and the hint says so. Single-cell reads are unchanged.
- **`tm1_sample_cells` with `includeStrings` uses `NONEMPTY` instead of a per-tuple `FILTER`.** The `FILTER` tested every tuple of the unpinned dimensions (51 s for 16 million on 11.8) and was not shortened by `maxCells`. A rule-calculated string without a feeder no longer shows up on v11; the empty-result hint points at `tm1_check_feeders`.
- **`TM1_LOCAL_FILE_ROOT` takes several directories**, separated by `;`. A host path is accepted when it lies inside any one of them.

### Fixed

- **`tm1_files_write` op='delete' no longer removes a v12 folder with everything in it.** In the `files` container a folder path went out as a plain `DELETE`, which v12 executes recursively. A folder holding entries is now refused with `UNSUPPORTED_OPERATION`; an empty one is deleted, in both containers.
- **A host path through a symbolic link whose target does not exist is refused.** It passed the `TM1_LOCAL_FILE_ROOT` check as a file still to be created, and the write then followed the link outside the root.
- **Sandbox mode refuses a control cube named with a leading space.** TM1 ignores spaces in names, so `' }CubeSecurity'` reached the control cube.
- **`tm1_write_cells` accepts the target sandbox as a qualified member** (`[Sandboxes].[Sandboxes].[mcp-x]`) instead of refusing it.
- **`tm1_write_cells` reports an unanswered per-cell write as `unknown`.** In the cell-by-cell fallback a cell whose `PATCH` timed out was listed as failed and invited a re-send, although it may be committed.
- **An error's own hint is no longer replaced by the tool's general one**, so advice such as a timeout's next step reaches the caller.
- **Unread response bodies are released.** A 401 before the re-login and the answer to an upload kept their connection.
- **`contracts:verify` exits non-zero** when the server no longer matches the recorded contracts.

## [10.6.0] - 2026-11-17

### Added

- **`tm1_read_server_file`** (v11): reads a text file the server wrote, such as an `ASCIIOutput` export, which v11 `Blobs` does not list. It runs an unbound TI process that copies the file into the logging directory, reads the copy and deletes it. The tool runs TI and can open any file the TM1 service account can, so it is not READ_ONLY and readonly connections refuse it.
- **`TM1_MODE=sandbox`** (set per connection in its `.env`): a mode between `readonly` and `readwrite`. It registers the read tools plus `tm1_write_cells`, `tm1_create_sandbox`, `tm1_discard_sandbox` and `tm1_delete_sandbox`, and every write must go into a sandbox whose name starts with `TM1_SANDBOX_PREFIX` (default `mcp-`). Base data, and sandboxes other applications keep under the same account, cannot be written. Control cubes (`}…`) are refused even into a sandbox. New tools: `tm1_list_sandboxes` and `tm1_compare_sandbox` (read-only), `tm1_publish_sandbox` (readwrite only). `tm1_execute_mdx` and `tm1_write_cells` take a `sandbox` argument. On a TM1 server with `DisableSandboxing=T` the sandbox tools answer `UNSUPPORTED_OPERATION` with that reason, and sandbox mode warns once that nothing can be written.

### Security

- `undici` raised to 8.12.4. Among the fixed advisories is GHSA-2m5v-pch6-74hx, a TLS certificate validation bypass through dropped `tls` options in `Agent`; the TM1 dispatcher builds exactly such an `Agent`.
- `@modelcontextprotocol/sdk` raised to 1.32.2. Transitive lockfile entries raised as well: `hono` 4.13.19, `@hono/node-server` 2.1.9, `qs` 6.17.1 and `ip-address` 10.7.6, which clear the open advisories `npm audit` reported for the HTTP transport. `npm audit --omit=dev` reports no vulnerabilities.

### Fixed

- **A TM1 response whose body stalls is bounded by the request timeout.** The timeout ended when the response headers arrived, so a server that sent headers and then stopped hung the tool call forever. The body is now read under the same deadline on every request path, including the raw and binary readers, login, keep-alive and logout. The deadline restarts at every body chunk, so a large result that keeps streaming is not cut off.
- **Cellsets are released after a cancelled or timed-out read.** The cleanup `DELETE` inherited the caller's signal, which was already aborted, so it was never sent and the cellset stayed on the server. It now runs with its own 10 s budget.
- **`tm1_write_cells` no longer replays a chunk whose outcome is unknown.** A timeout, a lost
  connection or a 5xx on the bulk write started the cell-by-cell fallback, which re-sent up to 500
  cells that might already be committed, and then reported success. The fallback now runs only when
  TM1 refused the chunk (4xx). Otherwise the call fails with the original error code and `details`
  holding `written`, the `unknown` index range and `notAttempted`.
- **`tm1_write_cells` reports committed chunks when a later chunk cannot be sent.** A failing
  ExecuteMDX for chunk 2 (e.g. a wrong element name in cell 501) returned the bare server error,
  although chunk 1 was already written. The error now carries the usual `written` / `failed` /
  `notAttempted` split.
- **`tm1_execute_chore` says the chore may be running after a timeout, lost connection or 5xx.** The
  hint now says the outcome is unknown and points at Threads (v11) or Jobs (v12) before any re-run.
- **Logout now ends the TM1 session.** It sent `DELETE /api/v1/ActiveSession`, which TM1 11.8 and
  12.5 answer with `400 DELETE not supported on this resource!`. The session stayed open until its
  idle timeout, so every server start left one behind. Logout now calls
  `POST /api/v1/ActiveSession/tm1.Close`, and a refused logout is logged as a warning instead of
  as "Logged out".
- Schema slimming in `tools/list` still applies with `@modelcontextprotocol/sdk` 1.32.2. That SDK installs its own `tools/list` handler when the server declares the `tools` capability, so the server no longer declares it; the SDK advertises it on the first tool registration. Wrapping a server whose `tools/list` handler already exists now throws instead of shipping unslimmed schemas.
- **The keep-alive runs after a failed first login.** The timer started only after the login succeeded, so a first login that failed left no keep-alive: later tool calls logged in lazily, but nothing kept the session alive, and `tm1_get_server_state` reported `connected: false`. The timer now starts before the login, and `connected` follows the held session. While TM1 stays unreachable the timer retries the login each interval; a rejected login (401/403) still stops all attempts.
- **Dimension names match the way TM1 matches them.** `tm1_write_cells` and `tm1_check_writable_coords` refused `costcenter` as an unknown dimension on a cube with `Cost Center`, because the lookup compared names without case only. They now compare without case and without spaces, as TM1 does, and so does the attribute lookup of `tm1_update_element_attribute_value`.
- **`tm1_search_elements` rejects an empty cube or dimension name.** `cubeName: ""` passed the "exactly one of" check and searched a dimension literally named `undefined`. Both inputs now require a non-empty name, and the handler branches on whether each input is given rather than on its truthiness.

## [10.5.1] - 2026-11-09

First published release of the 10.5.0 changes: the 10.5.0 publish failed CI on test formatting and never reached npm.

## [10.5.0] - 2026-11-09

### Added

- `tm1_check_process_code` and the `tm1_upsert_process` dry run return an advisory `lint` block, because code that compiles can still run wrong. It reports a function in a tab IBM restricts it from, code after ProcessQuit/ItemSkip, datasource settings after the Prolog, and literal credentials. It also names the cause of the compiler's unhelpful error on a trailing `# comment`. `lint` never changes `ok`. The same rules run in `tm1_audit_complexity scope='antipatterns'`. Rule ideas come from deutschebahn/linti.

## [10.4.0] - 2026-11-03

### ⚠️ Behavior change

- MCP resources (`tm1://` URIs and subscriptions) and MCP prompts are removed. Use the tools, and the tm1-mcp plugin skills, instead.
- `tm1_diff_process_with_file` returns the same tab diff as `tm1_diff_processes`: `linesA`/`linesB` (installed/file) and line `hunks` replace `installedLines`/`fileLines`, with a `contextLines` input.
- JSON tool results are no longer pretty-printed.
- `tm1_get_all_cube_rules` summaries use the same counting as the rules metrics: `ruleCount`/`feederCount` count `[`-statements, and commented-out `DB()` calls no longer appear in `referencedCubes`.
- `skipCheck` on cube rules is true only for a real `SKIPCHECK;` directive (a trailing `# comment` is allowed), not for any text containing the word.

### Fixed

- Rules cell references with mixed qualified and positional elements (`['Year':'2026','Sales']`) and names with `''` escapes are now found by the call graph and object-usage analysis.
- The install preflight no longer reports a missing cube for `SubsetCreateByMDX('MySub', …)`. Subset functions read the dimension from the first argument (TM1 order), and preflight checks cube and dimension names for every TI function in the shared argument table except existence probes and destroys of the object itself. `DBR`/`DBS`/`DBSS` cube references now appear in the call graph.
- TI parsing handles `''` inside strings and quoted parentheses in conditions consistently across the call graph, data flow and preflight.

## [10.3.0] - 2026-11-02

### ⚠️ Behavior change

- Unknown tool arguments are rejected with the list of accepted ones: a silently dropped `query` made `tm1_rest_read` return the same unfiltered list three times.

## [10.2.0] - 2026-10-28

### Changed

- Shorter tool descriptions: a fact repeated across tools is said once, and text that restated
  a tool's own parameters or told version history is gone (tools/list about 9 KB smaller).
- Shorter tool descriptions and error messages for the DB() rules checks; the checks are
  listed once, in `tm1_check_cube_rule`.

### Fixed

- The TI reference check matched cube and dimension names case-insensitively but not
  space-insensitively, so a reference to `Total Year` was reported missing when the server
  had `TotalYear`. It now uses TM1 name rules, as it already did for elements.
- `tm1_diagnose_process_error`: `since` never excluded a log. It now filters on the
  filename timestamp, as `tm1_list_error_logs` does.
- Parameter texts on the wire lost the space before a dot (`the.json`) and kept stray
  punctuation where a "Default" phrase was stripped.

### Removed

- `fetchAll` on the paged tools (`tm1_execute_mdx`, `tm1_get_view`, `tm1_files_read`, `tm1_search_rules`, `tm1_list_error_logs`, `tm1_search_code`): use `limit=0` (all rows, capped at 5000).
- `versionOverride` and the `appliedMajor` field on `tm1_audit_naming`: no replacement. `detectedMajor` is the server version, and no naming rule depends on it.

## [10.1.0] - 2026-10-27

### Added

- `tm1_rest_read` reads a cube's storage dimension order:
  `Cubes('C')/tm1.DimensionsStorageOrder()`. It was refused as an action, and without it a
  `tm1.ReorderDimensions` write could not be checked or undone. `Cubes('C')/Dimensions` gives
  the display order, which a reorder does not change.
- The TI reference check (`tm1_validate_process_refs` and the install preflight of
  `tm1_upsert_process`, `tm1_import_pro_file`, `tm1_import_process_from_git`,
  `tm1_install_pro_bundle`) reports two run-time failures that TM1's compiler passes.
  `elementCount`: a cell call (CellGetN/S, CellPutN/S, ...) passes a different number of
  elements than the cube has dimensions, and the run aborts with "Wrong Number of Dimension
  Elements". Until now such calls were silently skipped. `uncommittedElement`: an
  AttrPut*/ElementAttrPut* on an element that DimensionElementInsert/HierarchyElementInsert added
  earlier in the same Prolog or Metadata tab. The insert commits only when the tab ends, so the
  write fails with "Element not found" on the run that creates the element. The preflight refuses
  both; `preflight:false` skips it.
- `tm1_check_cube_rule` and the `tm1_set_cube_rules` preflight check every `DB()` on a literal
  cube name: the cube must exist, the element count must match its dimensions (Sandboxes not
  counted), and each literal element must resolve in its dimension (aliases count).
  tm1.CheckRules accepts all three mistakes, and the rule then reads 0 without an error.
- `tm1_check_all_cube_rules` runs those checks on the stored rules of every cube and returns the
  cubes with errors. TM1 lets an element or cube that a stored rule names be deleted, keeps the
  rule text, and the rule then computes nothing without an error; this finds those rules.

### Security

- The shipped `npm-shrinkwrap.json` moves body-parser to 2.4.0 (GHSA-27r3-jxmh-p828, high) and
  fast-uri, hono, ip-address and qs past newer advisories.

## [10.0.0] - 2026-10-17

Merged upstream 6.0.0 and 6.1.0.

### Breaking

- **`tm1_export_process_to_git` writes the server's REST payload as the `.json`** (`Name`,
  `UIData`, `VariablesUIData`, `Parameters`, ... in the server's key order, same bytes as the VS Code
  extension), not the lowercase `name`/`parameters` layout. This also applies to the automatic
  process backups. `tm1_import_process_from_git` reads both layouts, so older backups still
  restore. *Action:* re-export stored `.json` files once, or the next export shows every file as
  changed; anything outside this repo that reads the lowercase keys needs updating.

### Added

- `tm1_search_elements` finds elements by a business term: a case-insensitive substring match on
  names and Alias values, plus the String attributes named in `attributes`, for one hierarchy or
  every dimension of a cube (except `Sandboxes`). `total` counts every match even when `topN` caps
  the list. It runs as an MDX `FILTER` on the server, because OData cannot filter on attribute values.
- Planning Analytics SaaS: `TM1_AUTH_MODE=saas` with `TM1_TENANT`, `TM1_DATABASE` and `TM1_API_KEY`
  (a keychain secret like any other). The tenant is part of the connection id. Validated upstream
  against PA SaaS 12.6.4; not tried in this fork.
- A connection with `TM1_SSL_REJECT_UNAUTHORIZED=false` on `https` logs a warning, once, when its
  client is created.

### Changed

- The `.ti` parser keeps your own `#Region` folds as code and reads the VS Code extension's former
  `#region prolog` layout. A process without code exports as one empty Prolog region.
- `tm1_import_process_from_git` refuses a `.json` with unknown keys, or with `parameters`,
  `variables` or `dataSource` missing or `null`; before, it cleared all three on the server. It
  also writes `UIData` and an empty `VariablesUIData`. The preflight no longer needs its own
  check that the tabs cover the blob: the parser refuses code outside a tab and a repeated tab.
- `tm1_export_process_to_git` warns when the import would refuse the pair it just wrote.
- Error-log tools let TM1 sort, filter and cap the `ErrorLogFiles` listing.
- `tm1_delete_elements` says that deleting a leaf takes its cell values with it.

### Fixed

- `.pro` files: code past a too-low section line count is kept, and `UIData` (line 576),
  `HasSecurityAccess` (line 1217) and an empty `VariablesUIData` (`582,0`) survive a round trip. A
  variable position of `0` is kept. `tm1_install_pro_bundle` applies them too.
- Variables named `NVALUE`, `SVALUE` or `VALUE_IS_STRING` are refused with their names;
  `asciiDelimiterType` accepts only `Character` or `FixedWidth`.
- A programming error in the request path is no longer retried as a network failure, and a TM1
  message that only says "not authorized" is no longer reported as `PERMISSION_DENIED`.
- The HTTP transport answers `GET` and `DELETE /mcp` with 405, and a failed server build with 500
  instead of hanging.
- Test fixtures use invented object names.

## [9.3.0] - 2026-10-13

### Added

- The server starts with no connection folder (or a missing one). `tm1_list_connections` returns
  `[]` plus a hint on where to create `<name>/.env`; other tools fail with
  `No TM1 connection configured under <dir>`. Why: first-time setup no longer needs a working
  connection before the tools exist. Tools are all listed in that state and enforce mode and
  version per call; a client that started empty sees `connection` as a plain string, not an enum.
- Connections are rescanned on demand (no file watcher), from `tm1_list_connections` and before an
  "Unknown connection" error: new folders appear, removed ones go, and a folder whose `.env` mtime
  changed is replaced if its connection has no live session (never connected, logged out or latched).
  Why: adding or fixing a connection no longer needs an MCP restart or `/mcp` reconnect.

### Changed

- A rejected login (401/403) no longer stays latched until restart: the latch lifts when the `.env`
  mtime or the hash of the keychain secret differs from what the rejected login used, and the next
  call then tries once. Unchanged inputs keep the latch, so a wrong password still costs one login.
  An unreadable keychain keeps the latch. Legacy `TM1_BASE_URL` mode has no folder to watch and
  still needs a restart. The error now says "fix the credentials (secrets set) and retry".
- `secrets set` prompts `TM1_PASSWORD for <name> (input hidden; right-click pastes in the classic console):`.

### Migration

- Startup with an empty or missing connections dir used to exit with "No TM1 connections found";
  it now serves an empty registry. A dir whose folders all fail validation still exits.

## [9.2.0] - 2026-10-05

### Changed

- Host-file paths (`filePath`, `writeToFile`, `writeToDir`, `jsonPath`/`tiPath`, `directory`) work
  on stdio without `TM1_LOCAL_FILE_ROOT`. Over HTTP they stay disabled until it is set. A root,
  when set, still confines paths on either transport.
- The package ships `docs/`, which the README links to.

## [9.1.1] - 2026-10-01

### Changed

- Internal clean-up only, no change to any tool: unused exports, dead helpers and the unused
  `pino-pretty` dev dependency removed; the nightly live runner, the coverage ratchet and the
  live handshake tier of `smoke:tarball` dropped; contributor boilerplate and the stale
  `docs/EXAMPLES.md` deleted.

## [9.1.0] - 2026-09-30

### Added

- **`TM1_PROXY`** routes all TM1 requests through a SOCKS5 proxy (`socks5://` or `socks5h://`),
  so servers reachable only via a proxy no longer need a local forwarding bridge. `TM1_BASE_URL`
  names the real target. The request timeouts stay switched off, and TLS verification still
  follows `TM1_SSL_REJECT_UNAUTHORIZED`. Other schemes fail at startup.

### Changed

- **Smaller package:** 384 kB instead of 545 kB, with 196 files instead of 395. The tarball ships
  compiled JavaScript, `NOTICE` and `npm-shrinkwrap.json` only. TypeScript declarations, `docs/`
  and `CHANGELOG.md` are no longer included (this is a bin-only package; the docs live on GitHub).

### Security

- `ip-address` (via the MCP SDK) pinned to 10.7.2 for GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc,
  GHSA-j6r3-76f7-8jcv and GHSA-h3mg-xc3c-68pw.

### Fixed

- The MCP prompt texts named tool arguments that no longer exist.
- The `tm1_upsert_process` description pointed at the removed `tm1_get_process_variables`.

## [9.0.0] - 2026-09-30

### Removed

- **BREAKING: 60 tools that wrapped one REST call are gone**, replaced by the generic REST and
  file tools below: `tm1_assign_client_group`, `tm1_cancel_job`, `tm1_cancel_thread`,
  `tm1_compile_process`, `tm1_create_chore`, `tm1_create_client`, `tm1_create_cube`,
  `tm1_create_dimension`, `tm1_create_element`, `tm1_create_element_attribute`,
  `tm1_create_hierarchy`, `tm1_create_mdx_view`, `tm1_create_native_view`, `tm1_create_subset`,
  `tm1_delete_chore`, `tm1_delete_client`, `tm1_delete_cube`, `tm1_delete_dimension`,
  `tm1_delete_element`, `tm1_delete_file`, `tm1_delete_hierarchy`, `tm1_delete_process`,
  `tm1_delete_subset`, `tm1_delete_view`, `tm1_find_orphan_dimensions`, `tm1_get_ancestors`,
  `tm1_get_audit_log`, `tm1_get_cell_value`, `tm1_get_client`, `tm1_get_descendants`,
  `tm1_get_element_attribute_values`, `tm1_get_file_content`, `tm1_get_hierarchy`,
  `tm1_get_message_log`, `tm1_get_server_info`, `tm1_get_subset`, `tm1_get_transaction_log`,
  `tm1_get_view_definition`, `tm1_invalidate_callgraph_cache`, `tm1_list_chores`,
  `tm1_list_clients`, `tm1_list_cubes`, `tm1_list_dimensions`, `tm1_list_element_attributes`,
  `tm1_list_files`, `tm1_list_groups`, `tm1_list_jobs`, `tm1_list_processes`, `tm1_list_sessions`,
  `tm1_list_subsets`, `tm1_list_threads`, `tm1_list_views`, `tm1_remove_client_group`,
  `tm1_search_files`, `tm1_toggle_chore`, `tm1_unload_cube`, `tm1_update_client`,
  `tm1_update_element`, `tm1_update_subset`, `tm1_upload_file`. What a model cannot redo in one
  call moved into kept tools: the cache reset is `refresh: true` on `tm1_analyze_callgraph`, and
  the impact check before deleting a cube or dimension is `tm1_analyze_object_usage` (now with
  `usedInCubes`). The service methods, types and schemas only these tools used are gone too.

### Added

- **`tm1_rest_read` / `tm1_rest_write`**: any TM1 REST path relative to `/api/v1/`. The read
  tool issues GET (plus the read-only `Processes('P')/tm1.Compile`), drops `@odata.*`, masks
  secrets, and cuts `value[]` to a character budget (`truncated`, `kept`/`total`). The write
  tool refuses what a kept tool owns (process bodies, rules, cell writes, SaveData, clears,
  files, Execute actions, `$batch`, `$entity`) and names the tool to use. DELETE and cancel
  actions need `confirm` set to the key of the object they hit. Deleting a dimension's
  same-named hierarchy is refused: TM1 11.8 accepts it and leaves the dimension with none.
- **`tm1_files_read` / `tm1_files_write`** replace the five file tools (`op`: list, search, get /
  upload, delete).
- **`tm1_list_connections` reports this MCP server's `server: { name, version }`**, which only
  `tm1_get_server_info` carried before. It makes no TM1 call, so a client can check the version
  before its first request to TM1.

### Changed

- Hints, tool descriptions, prompts and the server instructions name REST paths instead of the
  removed tools. The instructions carry the `$select`, control-object
  (`not startswith(Name,'}')`) and `tolower()` rules.
- The live suite builds its fixtures through the REST tools; `tests/live/rest.live.test.ts`
  checks the paths the hints name. Wire contracts were re-recorded on 11.8.03500.4, and a request
  with its own `$select` is checked in subset mode.

- **`tm1_trace_cell_calculation` lists each rule statement once.** Nodes carry `statementRefs`
  into a top-level `statementTable` instead of repeating the full rule text; one quarter of a
  rule-heavy cube was mostly the same statement. `dedupeStatements=false` restores per-node
  `statements`.

### Fixed

- **The trace tools accept a coordinate without `Sandboxes`.** `tm1_check_feeders`,
  `tm1_trace_feeders` and `tm1_trace_cell_calculation` bind a left-out `Sandboxes` to `Base`,
  as `tm1_get_cell_value` does, instead of refusing the dimension count.

## [8.3.1] - 2026-09-29

### Removed

- The tool-surface size gate (`lint:tool-surface-budget`) is out of `verify`, and
  `scripts/measure-tool-surface.mjs` / `measure:tools` are gone. Clients load tools on demand,
  so the combined size no longer needs a hard cap.

### Fixed

- **The package now ships `docs/`.** The README links to `docs/CONFIGURATION.md` for the
  keychain setup, and the installed copy had no such folder, so the only offline reference for
  `secrets set` was `dist/secrets-cli.js`.
- **`secrets` commands name the scoped package.** `npx tm1-mcp-server secrets …` resolves to
  upstream, which has no `secrets` command. Messages, `.env.example` and the docs now say
  `npx -y @ffschrattenecker/tm1-mcp-server secrets …`.
- **The `AUTH_FAILED` hint no longer sends you to env vars.** With `TM1_SECRETS=keychain` the
  password is in the OS keychain, and a rejected login is not retried, so the hint now names
  both places and the restart.
- `docs/CONFIGURATION.md` says the `secrets set` prompt echoes under Git Bash/mintty.

## [8.3.0] - 2026-09-29

### Added

- **Compare two environments (DEV vs PROD) without reading either side into the model.** When
  more than one connection is configured, the comparison tools take a `connectionB` next to
  `connection` (default: the same connection, so they also compare two objects on one server):
  - `tm1_compare_environments` — drift overview per object type (cubes, dimensions, processes,
    chores): what exists on one side only, what differs and in which aspect, and which tool to
    drill into it with. `deep=true` also fingerprints every hierarchy's elements and edges.
    Processes compare on code, parameters and datasource type/source/view/subset. A changed
    ODBC query or variable list shows only in `tm1_diff_processes`. Chore `schedule` includes the
    start time, so independently built environments usually differ there.
  - `tm1_diff_cube_rules` — rule text as unified hunks, plus dimension list and
    SKIPCHECK/FEEDERS presence.
  - `tm1_diff_hierarchy` — elements, edges, weights, reparented children and attribute
    definitions; attribute values on request.
  - `tm1_diff_processes` now diffs a process across connections; `processB` defaults to
    `processA`.

### Changed

- **A cube's leading `Sandboxes` dimension is ignored when comparing dimension lists** in
  `tm1_compare_environments` and `tm1_diff_cube_rules`. `EnableSandboxDimension` adds it to
  every cube, so without this every cube differed from a server that has the setting off. The
  full lists are still returned.
- **`contracts:record` / `contracts:verify` work with keychain connections.** With
  `--connection=<name>` they run through `test:live:for`, which reads `TM1_SECRETS=keychain`
  folders and probes one login before any test file runs. `contracts:verify` no longer
  defaults to `tm1-test`; name the server like `contracts:record`.
- **Text diffs skip the common head and tail before diffing**, so a one-line edit in a long rule
  file or process costs a table the size of the edit. A changed region too large to diff
  (over 16M LCS cells) reports line counts with `tooLarge: true` instead of hunks.

### Security

- **Process datasources are read without their credentials.** `listDataSources` (used by
  `tm1_trace_data_flow` and `tm1_compare_environments`) selected the whole `DataSource`, so
  TM1 sent every process's datasource password, user name and ODBC query, which the client
  then dropped. It now selects type, source, view and subset only.
## [8.2.0] - 2026-09-28

### Fixed

- **Connections through a PAW gateway (`…/api/v0/tm1/<db>`) log in.** The gateway names the
  session cookie `TM1SessionId_<db>` and authenticates later requests by its `paSession`
  cookie, so the login failed with "no TM1SessionId cookie found". The server now keeps every
  cookie such a login sets and sends them back; direct TM1 connections are unchanged.

### Changed

- **`tm1_execute_process`, `tm1_execute_chore` and `tm1_save_data` run as TM1 async
  operations** (`Prefer: respond-async`, polled from `/_async('id')`). A long run no longer
  hits the 30s request timeout, and `timeoutMs` now caps the whole wait (default one hour)
  instead of a single request. Running out of it stops the waiting, not the run: the
  `LOCK_TIMEOUT` says it is still running.
- **Cancelling one of these calls now cancels the run on the server.** Before, the TI process
  kept running after a client-side cancel. Measured on 11.8: the thread is gone and the run's
  writes are rolled back, the same as `tm1_cancel_thread`. A chore under `MultipleCommit` keeps
  the steps it had already committed. v12 is not measured yet. This includes a client that
  cancels the call when its own timeout fires; all three tools now send progress heartbeats
  every 5s, so clients that reset their timeout on progress keep waiting.

## [8.1.0] - 2026-09-28

### Added

- Connection secrets can live in the OS keychain instead of the `.env`: set `TM1_SECRETS=keychain`
  in a connection folder and store the secrets with `npx tm1-mcp-server secrets set|list|delete`,
  or move an existing `.env` over with `secrets migrate <connection>`. The keychain is read the
  first time a connection is used, never when connections are listed. At startup the server warns
  about connections that still keep plaintext secrets. See
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md#secrets-in-the-os-keychain--tm1_secretskeychain).

### Changed

- **`tm1_clear_cube` no longer declares `dimensions`/`tuples`.** They are dropped like any
  unknown input, so an old call that still sends them empties the whole cube once `confirm`
  matches. *Action:* remove them from stored calls; a partial clear is a TI process.

## [8.0.0] - 2026-09-28

Merged upstream tm1-mcp-server 5.0.0 (flameY3T1, 2026-09-27). Where both lines had
built the same thing, upstream's behaviour was taken; fork-only features (connection
registry, `tm1_delete_elements`, rules patch mode, batch attribute writes, the
response-size guard, the per-connection caches) are unchanged.

### Breaking

- **`tm1_move_element` is removed.** It attached the element to the new parent but left it
  under the old one. *Action:* use `tm1_update_element` on both parents' `components`.
- **`tm1_clear_cube` takes only `cubeName` and `confirm`** (plus `timeoutMs`). The
  `dimensions` and `tuples` inputs advertised a region clear the server cannot do: the only
  route that works is a TI with `CubeClearData`, which empties the whole cube. A call that
  still carries them is refused and nothing is cleared. *Action:* use a TI process for a
  partial clear.
- **`tm1_write_cells` refuses a consolidated coordinate.** Every coordinate is checked before
  anything is sent; write the leaves or run a TI process.
- **`tm1_set_cube_rules` fails with `VALIDATION_ERROR` when the preflight finds syntax
  errors** (the errors are in `details`), instead of returning an `isError` payload. The check
  still runs on the full resulting text, so an `edits` patch is checked as installed.
  *Action:* `preflight: false` writes the text as is.
- **Exported files hold the process code unmasked.** `'***'` in written files broke the
  round-trip; `maskSecrets` now affects only the inline response of
  `tm1_export_process_to_git`. Keep such files out of version control if the code contains
  password literals.
- **An unknown `TM1_MCP_TRANSPORT` or `TM1_LOG_LEVEL` stops the server at startup** instead of
  falling back silently. Both are server-wide; a bad value in one connection's `.env` cannot
  occur because folders may not set them.
- **Unknown attributes are `NOT_FOUND`** in `tm1_update_element_attribute_value` (was
  `VALIDATION_ERROR`), and attribute names match ignoring case and spaces, as TM1 does.

### Added

- **The five file tools reach the Applications tree** via `container: "applications"`.
- **`tm1_get_file_content` takes `encoding: "base64"`** for binary files. Its `maxBytes` default
  is 48 KB there (64 KB for text), so a default read fits the 80k response limit.
- **Subset tools take `isPrivate`.**
- **`tm1_upsert_process` takes `variablesUIData`** and warns when the kept column layout no
  longer fits the variables.
- **`tm1_clear_cube` takes `timeoutMs`** (1 s to 1 h).
- **Feeder and cell-trace tools address alternate hierarchies** with `Hierarchy:Element`.
- **The attribute value tools take `hierarchyName`** for alternate hierarchies (single element
  and `updates[]`).

### Fixed

- **A rejected login is never retried.** A 401/403 on login latches for that connection, so
  wrong credentials no longer lock the account; fix the `.env` and restart.
- **MCP SDK 1.30.1**; `fast-uri` out of the vulnerable range; `npm run verify` runs
  `npm audit` first.
- **The ReDoS guard rejects repeated alternations** such as `^(\w|\w)*!$`.
- **The HTTP transport caps a request body at 64 MB** (413) and accepts `Host: localhost:<port>`
  and `[::1]:<port>`.
- **A v12 connection no longer demands `TM1_PASSWORD`** for auth modes that never send one.
- **A TM1 request can wait longer than five minutes**; `timeoutMs` is the only limit.
- **`tm1_write_cells` no longer writes when its own pre-check failed.**
- **`tm1_check_writable_coords` understands `[Dimension].[Hierarchy].[Element]`** and looks in
  the hierarchy the write would hit.
- **`fetchAll` and `limit: 0` on `tm1_execute_mdx` and `tm1_get_view` stop at 5000 cells.**
- **`tm1_check_cube_rule` returns syntax errors as a normal result**, not as a tool error.
- **`tm1_clear_cube` tells the truth on a timeout**: the clear finishes on the server.
- **`tm1_update_subset` can change the element list** (replaces, in order).
- **`tm1_get_descendants` and `tm1_get_ancestors` load only the subtree**, and `leavesOnly`
  no longer returns empty consolidations.
- **`tm1_update_element` reports type conversions.**
- **Process imports remove what the source no longer has** (parameters, variables, data
  source); a `.pro` round trip keeps trailing whitespace.
- **Process analysis reads variable names with `.`, `$`, `%` and backtick, and `;;` inside a
  string literal.**
- **Both diff tools compare the delimiter type and the ODBC unicode flag.**
- **`tm1_list_error_logs` reads v12 log names**, and `groupBy: "process"` passes schema checks.
- **`tm1_list_clients` and `tm1_list_groups` show names in markdown.**
- **`tm1_check_v12_readiness` gives the right reason for `SetODBCUnicodeInterface`.**
- **Seven tools no longer claim to be v11-only**, among them `tm1_import_pro_file` and
  `tm1_install_pro_bundle`.
- **Corrected descriptions** of `tm1_unload_cube`, `tm1_clear_cube`, `tm1_delete_hierarchy`,
  `tm1_get_cube_stats` and `tm1_get_transaction_log`.
- **The wire contracts were re-recorded against 11.8** upstream and merged with the fork's
  own recordings; the recorder now merges by default (`--replace` starts over).

Older history (before 8.0.0): see the git tags and the upstream repository,
https://github.com/flameY3T1/tm1-mcp-server.

[Unreleased]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v11.0.0...HEAD
[11.0.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.6.0...v11.0.0
[10.6.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.5.1...v10.6.0
[10.5.1]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.5.0...v10.5.1
[10.5.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.4.0...v10.5.0
[10.4.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.3.0...v10.4.0
[10.3.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.2.0...v10.3.0
[10.2.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.1.0...v10.2.0
[10.1.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v10.0.0...v10.1.0
[10.0.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.3.0...v10.0.0
[9.3.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.2.0...v9.3.0
[9.2.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.1.1...v9.2.0
[9.1.1]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.1.0...v9.1.1
[9.1.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.0.0...v9.1.0
[9.0.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.3.1...v9.0.0
[8.3.1]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.3.0...v8.3.1
[8.3.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.2.0...v8.3.0
[8.2.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.1.0...v8.2.0
[8.1.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.0.0...v8.1.0
[8.0.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v7.0.2...v8.0.0
