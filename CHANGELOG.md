# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.2.0...HEAD
[9.2.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.1.1...v9.2.0
[9.1.1]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.1.0...v9.1.1
[9.1.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v9.0.0...v9.1.0
[9.0.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.3.1...v9.0.0
[8.3.1]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.3.0...v8.3.1
[8.3.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.2.0...v8.3.0
[8.2.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.1.0...v8.2.0
[8.1.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v8.0.0...v8.1.0
[8.0.0]: https://github.com/ffschrattenecker/tm1-mcp-server/compare/v7.0.2...v8.0.0
