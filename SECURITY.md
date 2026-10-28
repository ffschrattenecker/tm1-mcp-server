# Security Policy

## Supported Versions

Only the latest published release receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security problems.**

This is a personal testing fork. If the issue is also in the original project,
report it to
[flameY3T1/tm1-mcp-server](https://github.com/flameY3T1/tm1-mcp-server/security)
first. Report it here only if it is specific to this fork.

Report privately via GitHub's
[**Report a vulnerability**](https://github.com/ffschrattenecker/tm1-mcp-server/security/advisories/new)
(Security → Advisories → _Report a vulnerability_). This opens a confidential
advisory visible only to you and the maintainer.

Please include:

- affected version / commit
- a description of the issue and its impact
- reproduction steps or a proof of concept
- any suggested remediation

You can expect an initial acknowledgement within **7 days**. There is no bug
bounty — this is a personal fork maintained on a best-effort basis.

## Scope & Threat Model

This server bridges an MCP client (an LLM) to a live IBM Planning Analytics / TM1
instance over the TM1 REST API. Keep the following in mind before reporting:

- **Credential placement** is covered in
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md#where-credentials-are-read-from).
  A secret placed in a shared config file is documented misuse, not a
  vulnerability.
- **`readonly` is the default mode.** Destructive tools (cube/dimension
  deletion, cell writes, process execution) are disabled unless you explicitly
  opt in with `TM1_MODE=readwrite`. Enabling `readwrite` against production by
  choice is not a vulnerability.
- **HTTP transport binds loopback (`127.0.0.1`) by default.** Setting
  `TM1_MCP_HTTP_HOST=0.0.0.0` exposes the server and its TM1 credentials to the
  network; only do so behind a reverse proxy with its own auth. A self-inflicted
  LAN exposure via that flag is not a vulnerability.
- The LLM client ultimately decides which tools to invoke. Tool-level
  `readOnlyHint` / `destructiveHint` annotations are advisory; final
  authorization is the client's responsibility.

In scope: credential leakage paths, injection into TM1 REST calls, auth bypass
in the HTTP transport, secret-masking gaps, and anything that lets a tool act
outside its declared `readOnlyHint` / `destructiveHint` contract.
