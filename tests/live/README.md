# Live integration tests

These suites exercise the **real MCP tool layer against a running TM1 server**.
Every call goes through the same path an MCP client uses: the tool's zod input
schema (defaults + validation), the `withAnnotations` wrapper (annotation
injection, error normalization, output-schema attach), the real handler, the
real `TM1Client`, and real OData. They are the complement to the mocked unit
tests under `tests/unit/` — those prove the logic in isolation; these prove the
calls actually work end-to-end against TM1 11.x.

## Opt-in — never runs by default

The default `vitest.config.ts` does **not** include `tests/live`, so
`npm test` / `npm run verify` never touch the network. Live tests run only via
their own config and only when a server is configured:

```bash
TM1_BASE_URL=https://host:port TM1_USER=admin TM1_PASSWORD=... npm run test:live
```

Without `TM1_BASE_URL` + `TM1_USER` in the environment, every suite skips itself
(`describe.skipIf(!LIVE_ENABLED)`), so the command is also safe to run blind in
CI — it just reports skipped. Credentials come from the environment / `.env`
(git-ignored) and are never committed.

## Against one connection folder — `npm run test:live:for`

To run against a connection from `~/.tm1/mcp-servers/<name>/.env` (or
`TM1_CONNECTIONS_DIR`), use the helper instead of loading the `.env` by hand:

```bash
npm run test:live:for -- my-dev tests/live/cube.live.test.ts
npm run test:live:for -- my-dev --retry-login   # after fixing a refused login
```

- The `.env` goes through `connectionEnv()` in `src/connections.ts`, the same
  dotenv parse and `TM1_*` isolation the MCP server uses. A hand-rolled parser
  once kept the quotes around a password, and every login failed.
- One login probe runs before vitest. Every live file logs in by itself, so
  without the probe a bad password costs one failed login **per file**, and
  that locks the account fast (see Troubleshooting below).
- A refused probe (401/403) writes `.live-reports/<name>.auth-failed.log` and
  blocks further runs for that connection until `--retry-login` is passed. An
  unreachable server leaves no marker, since it never saw the credentials.

## There is no CI live coverage — and none is planned

**Read this before you assume the tool surface is continuously verified against
a real TM1: it is not.** Live coverage exists only for the minutes in which
somebody runs these suites against a reachable server. Nothing on GitHub does.

The reason is routing, not effort. The TM1 servers this project is developed
against sit on a private network (the Windows host of a WSL box). A
GitHub-hosted runner cannot reach them. A scheduled workflow *could* be added
and would go green every night — because without `TM1_BASE_URL` + `TM1_USER`
every suite self-skips — but that green would mean "nothing was tested", and a
badge that says "passing" for a run that verified nothing is worse than no
badge at all. So that job deliberately does not exist.

Two honest ways to close the gap:

- **Run the scheduled script below** on a machine that can reach a TM1 server
  (the developer's WSL box, or any host with a route to the server).
- **Recorded-fixture contract suite** (Tier 6 item 1 of the 2026-08-05 review):
  check in sanitized real responses and assert the parsers against them in the
  normal CI, with no server involved. That is the only variant that can ever be
  server-free. **It is not built yet.** Until it is, CI proves the code is
  self-consistent, not that TM1 still answers the way it did.

## Safety model

- **Sandbox namespace.** Everything created is prefixed `ZZ_MCP_LIVE_<DOMAIN>`
  (see `SANDBOX` in `harness.ts`). No real model object is ever touched.
- **Lifecycle, not blind matrix.** Each domain runs a real
  create → read → update → delete chain, so destructive tools are covered in a
  controlled context rather than fired at production objects.
- **Idempotent cleanup.** Each file tears down its own objects in `afterAll`;
  `global-setup.ts`'s `teardown` is a safety net that sweeps any
  `ZZ_MCP_LIVE`-prefixed leftovers (including `}Subsets_…` control objects)
  after the whole run, in dependency order (chores → processes → cubes → dims).
- **Avoided:** unbounded `TransactionLogEntries` reads (slow full-scan /
  timeout trap; `rest.live` always filters by TimeStamp) and `tm1_save_data`
  (global flush).

## Layout

| File | Domain |
|------|--------|
| `harness.ts` | shared infra: connect, capture handlers, `call`/`ok`, REST fixtures (`restGet`/`restWrite`/`names`/`createDimension`/`createCube`/`dropIfExists`/`cellValue`), `sweepSandbox` |
| `global-setup.ts` | vitest globalSetup; `teardown` = safety-net sweep |
| `read-smoke.live.test.ts` | non-mutating read battery + error-envelope checks |
| `dimension.live.test.ts` | dimensions / hierarchies / elements / attributes / subsets-of-dim |
| `cube.live.test.ts` | cubes / cells / rules / MDX |
| `view.live.test.ts` | native + MDX views / subsets |
| `process.live.test.ts` | TI processes (upsert / compile / execute / diff / diagnose) |
| `chore.live.test.ts` | chores (deactivated; create / toggle / execute / delete) |
| `ops.live.test.ts` | server / security / files |
| `analysis.live.test.ts` | read-only audits over the existing model |
| `rest.live.test.ts` | `tm1_rest_read` / `tm1_rest_write`: cheat-sheet and monitoring paths, guard refusals |

## Writing a new live test

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: my domain", () => {
  let h: LiveHarness;
  beforeAll(async () => { h = await getHarness(); });

  it("does a thing", async () => {
    const r = await h.ok("tm1_some_tool", { name: `${SANDBOX}_MINE_X` });
    expect(r.json).toMatchObject({ /* ... */ });
  });
});
```

- `h.call(name, args)` returns `{ result, json, text, isError }` and never throws
  on a TM1 error — assert on `isError` / `json.code` for negative paths.
- `h.ok(name, args)` throws if the tool returned an error envelope — use for
  steps that must succeed.
- Prefix **every** created object with `${SANDBOX}_<DOMAIN>` and delete it in
  `afterAll` (the global sweep is a backstop, not a substitute).
- Build fixtures with the REST helpers: `createDimension(h, D, ["A", { name: "T", children: ["A"] }])`,
  `createCube(h, C, [D1, D2])` (TM1 needs at least two dimensions), `dropIfExists(h, seg("Cubes", C))`.
