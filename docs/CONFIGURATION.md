# Configuration reference

The short version lives in the [README](../README.md#configure); the full list
of variables with inline comments is [`.env.example`](../.env.example). This
page covers the settings that need more than a comment line.

## Where credentials are read from

Environment variables, resolved in this order (first hit wins per variable):

1. real shell / MCP-client `env:` vars
2. the `.env` file named by `DOTENV_CONFIG_PATH`
3. `.env` in the working directory the MCP client launches the server from
   (typically your project directory)
4. `.env` in the package root — the directory containing `dist/`. Works for
   clone+build installs; under `npx` this is the npm cache, so don't rely on it.

For the recommended `npx` install, put a `.env` in the project directory you
start your MCP client from, or point `DOTENV_CONFIG_PATH` at one via the MCP
config's `env` block. **Do not put `TM1_PASSWORD` in `.mcp.json` or
`settings.json`** — those files are routinely shared or committed. Keep secrets
in a `.env` that stays out of version control, or better, in the OS keychain.

## Secrets in the OS keychain — `TM1_SECRETS=keychain`

A connection's `.env` does not have to hold its password. With
`TM1_SECRETS=keychain` the server reads the secrets from the operating
system's credential store instead: Windows Credential Manager, macOS
Keychain, or the Secret Service (GNOME Keyring, KWallet) on Linux.

The fastest way to switch an existing connection is to move its plaintext
secrets out of the file:

```sh
npx -y @ffschrattenecker/tm1-mcp-server secrets migrate my-dev
```

This stores every secret of `~/.tm1/mcp-servers/my-dev/.env` in the
keychain, reads each one back, and only then removes those lines and adds
`TM1_SECRETS=keychain`. No plaintext backup is kept. Restart the MCP client
afterwards.

To set one by hand, you are prompted without echo, or it is read from stdin.
Run it in a real terminal (PowerShell, cmd, a POSIX tty): under Git Bash/mintty,
or any shell that is not a TTY to Node, the typed input is echoed.

```sh
npx -y @ffschrattenecker/tm1-mcp-server secrets set my-dev  # TM1_PASSWORD
npx -y @ffschrattenecker/tm1-mcp-server secrets set my-dev TM1_CLIENT_SECRET
npx -y @ffschrattenecker/tm1-mcp-server secrets list my-dev  # which keys are stored, never values
npx -y @ffschrattenecker/tm1-mcp-server secrets delete my-dev [KEY]
```

The keys that can live in the keychain are `TM1_PASSWORD`,
`TM1_CLIENT_SECRET`, `TM1_ACCESS_TOKEN`, `TM1_API_KEY` and
`TM1_CAM_PASSPORT`. Everything else stays in the `.env`.

Entries are stored under service `tm1-mcp-server` and account
`<connection>/<KEY>`. On Windows the Credential Manager target name is
`<connection>/<KEY>.tm1-mcp-server`, and the value is stored as UTF-16LE.
Other tools that read the same connection folders (such as the tm1-api
skill) look secrets up by these names.

Behaviour:

- Listing connections never reads the keychain. The secrets are read the
  first time a connection is used, so a missing entry fails only that
  connection, and the error names the `secrets set` command that fixes it.
- A `.env` that sets `TM1_SECRETS=keychain` **and** a non-empty plaintext
  secret is rejected as misconfigured. The server does not guess which one is
  current, because a stale password is a failed login that counts toward
  TM1's lockout. A blank `TM1_PASSWORD=` for a blank-password account is fine.
- At startup the server logs one warning listing the connections that still
  keep plaintext secrets in their `.env`.

What this protects: the secret is no longer in a file that gets synced,
backed up, committed, pasted into a chat or read into an AI agent's context.
What it does not protect against: any program running as your OS user can
read the keychain too, without a prompt on Windows.

## Several TM1 connections

One server process can serve any number of TM1 connections. Which mode it runs
in is decided at startup:

| Environment                 | Connections                                   |
| --------------------------- | --------------------------------------------- |
| `TM1_CONNECTIONS_DIR` set   | one per `<name>/.env` folder in that dir      |
| `TM1_BASE_URL` set (no dir) | a single connection, as before v7             |
| neither                     | one per `<name>/.env` in `~/.tm1/mcp-servers` |

`TM1_CONNECTIONS=dev,test` narrows discovery to the named folders.

**Set `TM1_CONNECTIONS_DIR` explicitly in the MCP entry.** The server also
reads a `.env` from the directory the client starts it in (see above); one
that sets `TM1_BASE_URL` would otherwise switch the server to a single
connection without a word. An explicit dir wins over `TM1_BASE_URL`:

```json
{
  "mcpServers": {
    "tm1": {
      "command": "tm1-mcp-server",
      "env": { "TM1_CONNECTIONS_DIR": "C:/Users/you/.tm1/mcp-servers" }
    }
  }
}
```

Tool names no longer carry the connection (`mcp__tm1__tm1_clear_cube` for all of
them), so a client permission granted for one connection applies to every
connection. Keep production folders `TM1_MODE=readonly` unless writes there are
intended: the per-call refusal is then the barrier, not the approval prompt.

With more than one connection every tool gains a required `connection`
argument (an enum of the folder names); with one, the tool schemas are exactly
as before. `tm1_list_connections` reports each connection's mode, TM1 version,
whether a session is open, and any configuration error. It makes no TM1 call.

**Per-connection settings come from the folder only.** Connection keys
(`TM1_BASE_URL`, `TM1_USER`, `TM1_MODE`, `TM1_VERSION`, the v12 and CAM keys, …)
in the server's own environment are not inherited, so a `TM1_MODE=readwrite` in
the launching shell cannot arm a folder that does not set it. Server-level keys
(`TM1_LOG_*`, `TM1_MCP_*`, `TM1_RESPONSE_MODE`, `TM1_MAX_RESPONSE_CHARS`) are read
from the process environment and cannot be overridden by a folder.

**Mode is enforced per call.** Write tools are listed when at least one
connection is readwrite; calling one against a readonly connection returns
`PERMISSION_DENIED` without touching TM1. Version-specific tools (v11 threads,
v12 jobs) are listed when any connection runs that version and refused against
the others.

**Nothing logs in at startup.** Each connection authenticates on its first
tool call. A folder whose `.env` is invalid is listed with its error and
skipped; the other connections keep working.

Resources are namespaced per connection: `tm1://<connection>/process/{name}/code`.
A resources/list only enumerates objects of connections that are already
connected, so browsing resources never logs in to every server.

## Response size — `TM1_MAX_RESPONSE_CHARS`

A successful result longer than this many characters (default 80000) is replaced
by a `RESPONSE_TOO_LARGE` error. Its hint says how to narrow the call, based on
the tool's own parameters: `offset`/`limit`, `lineRange`/`outline`, `countOnly`,
`maxBytes`. The result is never truncated, because a cut JSON payload is worse
than none. The default sits under Claude Code's MCP output cap. Raise it only for
a client that can take more.

## Wire format — `TM1_RESPONSE_MODE`

Default `legacy`: a successful result ships its payload both as
`content[0].text` and as `structuredContent`. That is what the MCP spec
recommends — a tool returning structured content SHOULD also return the
serialized JSON in a text block — and it is the only shape every client can
read.

`structured` drops the text block and sends `structuredContent` alone. It halves
the wire bytes and is spec-legal because every tool declares an `outputSchema`
(`CallToolResult.content` "may be empty" then), but **a client that reads
`content[]` and ignores `structuredContent` sees no output at all.** Kiro's IDE
MCP layer is one such client.

Only turn it on when your client copies the whole `CallToolResult` into the
model prompt — Q DEV CLI / Kiro CLI do — because there the duplicate really is
paid for twice. It buys nothing on Claude Code, which de-duplicates: the same
payload sent both ways costs one copy of context, measured byte-identical at
1 KB and at 23 KB, with the oversized offload-to-file path behaving the same
either way.

`format: "markdown"` and error results are unaffected by this setting.

### `format: "markdown"` and structuredContent

Tools that take `format` send the rendered table twice: as the text block and as
`structuredContent: { "markdown": "..." }`. The JSON payload is not included —
in markdown mode the table replaces it.

This is not redundancy for its own sake. Clients disagree about which field to
read (Kiro renders `content[]`, Claude Code reads `structuredContent` and drops
`content`), so a table placed in only one of them is invisible on the other.
Before 3.1.0 the table went out in `content[]` while `structuredContent` carried
the JSON, which made `format: "markdown"` a silent no-op on Claude Code — it
showed the JSON the caller had asked not to get.

Consequence for schema consumers: the published `outputSchema` of these tools
has optional top-level fields, because it must accept both shapes and MCP output
schemas cannot express a union. Responses are still validated strictly — the
server picks the matching strict shape per response before answering.

## Secrets — `TM1_ALLOW_UNMASKED_SECRETS`

Credential masking is on by default everywhere it applies. Several tools take a
`maskSecrets` parameter, and a **model** can set it to `false` — an opt-out of a
security control chosen by the thing being guarded against. That request is
ignored unless the operator sets `TM1_ALLOW_UNMASKED_SECRETS=true`. The default
degrades to "mask anyway" rather than failing the call, so an audit still gets
its report, just redacted.

## Local file access — `TM1_LOCAL_FILE_ROOT`

Tools that read or write files on the host running the server —
`tm1_import_pro_file`, `tm1_install_pro_bundle`, `tm1_diff_process_with_file`,
`tm1_validate_process_refs`, the git export/import pair and `tm1_set_cube_rules`
— take absolute host paths. On stdio any absolute path is allowed; over HTTP
they are **disabled** until `TM1_LOCAL_FILE_ROOT` is set. When it is set, on
either transport, every path must resolve inside that root (`..` and escaping
symlinks are rejected).

```env
TM1_LOCAL_FILE_ROOT=/srv/tm1-git    # optional; confines host-disk file params
```

It is server-wide: set it in the server environment (MCP `env:` block or a
user environment variable), not in a connection folder's `.env`, and restart
the server.

### What the git round-trip preserves

The roundtrip is lossless for code, parameters, variables, datasource and
`HasSecurityAccess` (exported to the JSON file, applied on import only when
declared — otherwise the server value is preserved; also settable via
`tm1_upsert_process`). `Caption` is intentionally not roundtripped: TM1 exposes
no reliable write path for it.

The `.ti` file holds the four tabs in TM1's **native `#region <Tab>` /
`#endregion` format** (the server `Code` property) — byte-identical to
`GET /Processes('x')/Code/$value` (CRLF, empty tabs omitted); nested user folding
regions inside a tab are preserved. A malformed or unbalanced blob is rejected on
import with a clear error rather than deployed partially.

**Breaking (since the previous `### TM1-TI-TAB:` format):** `.ti` files exported
by earlier versions are no longer importable — re-export from the server to
regenerate them.

## Process backups — `TM1_PROCESS_BACKUP_DIR`

Before `tm1_upsert_process`, `tm1_import_pro_file`, `tm1_import_process_from_git`
or `tm1_install_pro_bundle` replaces an installed process, the server exports the
installed version as a tm1-git pair and returns its paths as `backup: { json, ti }`
(per result entry for the bundle). Restore it with `tm1_import_process_from_git`.

```env
# TM1_PROCESS_BACKUP_DIR=/srv/tm1-backups   # default ~/.tm1-mcp-server/backups; "off" disables
```

- Files land under `<dir>/<host>_<port>[_<instance>_<database>]/<process>/<timestamp>.json|.ti`,
  so several connections can share one directory. Nothing is pruned.
- The directory is chosen by the server, not the caller, so it is independent of
  `TM1_LOCAL_FILE_ROOT`.
- The code is written **unmasked**: a masked backup would restore placeholder
  literals and fail at runtime. The ODBC datasource password is never written.
  Treat the directory like the TM1 data directory.
- A backup that cannot be written refuses the overwrite; nothing is changed on
  the server.

## TM1 v12 (Planning Analytics Engine)

Setting `TM1_INSTANCE` + `TM1_DATABASE` auto-selects v12: requests are rerooted
to `/{instance}/api/v1/Databases('{database}')/...` and login goes through
`POST /{instance}/auth/v1/session` instead of the v11 `/api/v1/ActiveSession`
flow. For v12, `TM1_BASE_URL` is address:port only (no path) — e.g.
`https://your-pae-host:443`.

```env
TM1_INSTANCE=my-instance
TM1_DATABASE=my-database
TM1_AUTH_MODE=s2s                   # s2s (default) | basic | access_token | oidc | iam
TM1_USER=admin                      # REQUIRED in every v12 mode (incl. s2s) — the session login "User"

# Per-mode credentials — set the ones your TM1_AUTH_MODE requires:
TM1_CLIENT_ID=my-client-id          # s2s
TM1_CLIENT_SECRET=my-client-secret  # s2s
# TM1_PASSWORD=...                   # basic (with TM1_USER)
# TM1_ACCESS_TOKEN=...               # access_token / oidc
# TM1_API_KEY=...                    # iam
# TM1_IAM_URL=https://iam.host       # iam
```

`TM1_AUTH_MODE` selects how the `auth/v1/session` request authenticates, each
with its own env vars:

| Mode            | Vars                                 | Validation status                     |
| --------------- | ------------------------------------ | ------------------------------------- |
| `s2s` (default) | `TM1_CLIENT_ID`, `TM1_CLIENT_SECRET` | **Live-validated** against PAE 12.5.9 |
| `basic`         | `TM1_USER`, `TM1_PASSWORD`           | Unit-validated request builder only   |
| `access_token`  | `TM1_ACCESS_TOKEN`                   | Unit-validated request builder only   |
| `oidc`          | `TM1_ACCESS_TOKEN`                   | Unit-validated request builder only   |
| `iam`           | `TM1_API_KEY`, `TM1_IAM_URL`         | Unit-validated request builder only   |

> Only `s2s` has been exercised against a live PAE server. The other modes'
> request builders are covered by unit tests but not yet confirmed against a
> real server — verify against your environment before relying on them.

### Tools that differ by version

`tm1_save_data` is registered on v11 only: v12 removed
`SaveDataAll`/`CubeSaveData` because the cloud engine persists automatically.
v12 also replaced threads with jobs — read `Threads` (v11) or `Jobs` (v12) with
`tm1_rest_read`. The file service auto-falls back from the v12
`Files` root to the v11 `Blobs` root.

## CAM (Cognos Access Manager) / LDAP

Set `TM1_NAMESPACE` to your CAM namespace and the client logs in with
`Authorization: CAMNamespace base64(user:password:namespace)` — `TM1_USER` and
`TM1_PASSWORD` are still required. On PA Cloud the namespace is usually `LDAP`;
use a non-interactive service account.

Alternatively supply a pre-obtained passport via `TM1_CAM_PASSPORT`
(`Authorization: CAMPassport <token>`, no user/password needed); it takes
precedence over the namespace method. Native TM1 auth stays the default when
neither is set.

base64 is encoding, not encryption — always use `https://`. Windows SSO via
SSPI/negotiate is not supported; obtain a passport out-of-band. The CAM path has
not been validated against a live CAM server.

## HTTP transport

The default transport is **stdio**, which is how this server is meant to be run:
one local process, one TM1 identity, one user (see
[Positioning](../README.md#positioning--this-is-a-single-user-tool)). The HTTP
transport exists for remote or multi-client setups and does not change that — it
is single-tenant, and everything below follows from that.

```env
TM1_MCP_TRANSPORT=http
TM1_MCP_HTTP_HOST=127.0.0.1   # default — bind loopback only
TM1_MCP_HTTP_PORT=3000        # default
TM1_MCP_HTTP_ALLOWED_ORIGINS= # optional, comma-separated extra Origins past DNS-rebinding protection
TM1_MCP_HTTP_TOKEN=           # optional, require "Authorization: Bearer <token>" on every /mcp request
```

Then `npm start` exposes a single `POST /mcp` endpoint speaking JSON-RPC
(stateless mode, no session IDs). DNS-rebinding protection is on by default and
`Host`/`Origin` are validated against `allowedHosts: [host:port, 127.0.0.1,
localhost]`.

Smoke test:

```bash
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
```

### Security

> Setting `TM1_MCP_HTTP_HOST=0.0.0.0` exposes the server (and your TM1
> credentials) to the LAN — only do this behind a reverse proxy with
> additional auth.
>
> The HTTP transport has **no built-in authentication** unless you set
> `TM1_MCP_HTTP_TOKEN`. When set, every `/mcp` request must carry
> `Authorization: Bearer <token>` (others get `401`). Without it, bind to
> loopback only or front the server with an authenticating reverse proxy.

The bearer token authenticates the _endpoint_, not the caller. Everyone who
reaches it shares the same TM1 credential, session, caches and audit identity.
The "fresh MCP server per request" wording in `src/http-transport.ts` describes
request isolation inside the process — it is not a security boundary between
users.

Credential hygiene, same as for stdio:

- Keep `TM1_PASSWORD` and any other secret only in `.env` (gitignored).
- `.mcp.json` and `~/.claude/settings.json` are often shared/committed —
  passing `env: { TM1_PASSWORD: "..." }` there leaks the credential into
  team configs, dotfile repos, and Claude Code session logs.
- If you must override per-host, use a per-host `.env` file rather than
  inline `env` blocks in client config.
- Need multiple TM1 environments? Use one folder per connection (see
  [Several TM1 connections](#several-tm1-connections)).

### autoApprove

`mcp.json.example` ships an `autoApprove` list of **read-only** tools only —
the analyze/audit/check/compare/diagnose/diff/get/list/resolve/sample/search/
trace/validate tools, `tm1_rest_read`, `tm1_files_read`, `tm1_execute_mdx` (a
query, not a mutation) and the `tm1_export_process_to_*` tools. Every tool that
changes the server deliberately stays **off** the allowlist and requires manual
approval per call: `tm1_rest_write`, `tm1_files_write`, `tm1_delete_elements`,
`tm1_clear_cube`, `tm1_execute_process`, `tm1_execute_chore`, `tm1_write_cells`,
`tm1_save_data`, `tm1_set_cube_rules`, the `upsert_*`/`update_*` tools
(`tm1_upsert_process`, `tm1_bulk_upsert_elements`, `tm1_update_chore`,
`tm1_update_element_attribute_value`), `tm1_copy_process`,
`tm1_import_process_from_git`, `tm1_import_pro_file` and
`tm1_install_pro_bundle`.

Each tool also publishes MCP `readOnlyHint` / `destructiveHint` /
`idempotentHint` annotations (declared per tool in its `defineTool()` spec) so clients that
surface those hints can warn before invoking destructive tools. Irreversible
full-replacement writes declare `destructiveHint: true` even though they delete
no object: `tm1_write_cells`, `tm1_set_cube_rules` and
`tm1_bulk_upsert_elements`.

## Troubleshooting

**TLS / self-signed certificate errors** (`unable to verify the first
certificate`, `self-signed certificate`): TM1 dev servers often use self-signed
certs. Set `TM1_SSL_REJECT_UNAUTHORIZED=false` for those — but only for dev,
never against production.

**TM1 only reachable through a SOCKS5 proxy:** set
`TM1_PROXY=socks5://proxy.example.com:1080` (optionally `user:pass@` for proxies
that require auth) and point `TM1_BASE_URL` at the TM1 host as the proxy sees it.
Every TM1 request is tunnelled; no local bridge process is needed. SOCKS4 and HTTP
proxies are rejected at startup.

**`401` / authentication failed:** verify `TM1_USER` / `TM1_PASSWORD` and that
`TM1_BASE_URL` points at the REST API port (e.g. `https://host:8010`). Some test
servers allow a blank admin password — an empty `TM1_PASSWORD` is accepted and
the server logs a warning rather than blocking, so the real TM1 `401` surfaces
with context. For CAM/LDAP servers a `401` usually means the wrong
`TM1_NAMESPACE` (or an interactive account on PA Cloud — use a non-interactive
service account); confirm the server's `IntegratedSecurityMode` in `tm1s.cfg` or with the TM1 admin.
The MCP cannot read it: `ActiveConfiguration/Access/Authentication` is masked
wholesale.

**v11 vs v12 feature errors** (`DataSource.usesUnicode`, hierarchy/`Files`
endpoints): set `TM1_VERSION=11.8` (or your `11.x`) so v12-only paths are
disabled. The file service auto-falls back from the v12 `Files` root to the v11
`Blobs` root.

**Transaction-log reads are slow or time out:** the TM1 transaction log is a
full scan. Always bound `TransactionLogEntries` with a tight TimeStamp filter
(`$filter=TimeStamp ge 2026-09-23T00:00:00Z`, a zoned ISO literal); broad
queries can hit the query timeout.

**Startup error `Invalid TM1_…: expected a positive integer`:** a numeric env
var (`TM1_KEEP_ALIVE_INTERVAL`, `TM1_REQUEST_TIMEOUT`, `TM1_MCP_HTTP_PORT`) has a
non-numeric or non-positive value. Fix the value or unset it to use the default.

**HTTP transport: `401 Unauthorized` on `/mcp`:** `TM1_MCP_HTTP_TOKEN` is
set — send `Authorization: Bearer <token>`.

**HTTP transport: connection refused / origin rejected:** the server binds
`127.0.0.1` by default and validates `Host`/`Origin`; add your origin to
`TM1_MCP_HTTP_ALLOWED_ORIGINS`, or set `TM1_MCP_HTTP_HOST` (loopback only
unless fronted by an authenticating proxy).
