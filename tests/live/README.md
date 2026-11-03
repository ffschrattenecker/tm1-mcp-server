# Live integration tests

These suites exercise the **real MCP tool layer against a running TM1 server**.
Every call goes through the same path an MCP client uses: the tool's zod input
schema, the `withAnnotations` wrapper, the real handler, the real `TM1Client`
and real OData. The unit tests under `tests/unit/` prove the logic in isolation
against mocks; these prove the calls work end-to-end against TM1 11.x and 12.

## Opt-in — never runs by default

`vitest.config.ts` does **not** include `tests/live`, so `npm test` and
`npm run verify` never touch the network. Live tests run through their own
config and only when a server is configured:

```bash
TM1_BASE_URL=https://host:port TM1_USER=admin TM1_PASSWORD=... npm run test:live
```

Without `TM1_BASE_URL` and `TM1_USER`, every suite skips itself
(`describe.skipIf(!LIVE_ENABLED)`). Credentials come from the environment or
`.env` (git-ignored) and are never committed.

## Against one connection folder — `npm run test:live:for`

To run against a connection from `~/.tm1/mcp-servers/<name>/.env` (or
`TM1_CONNECTIONS_DIR`), use the helper instead of loading the `.env` by hand:

```bash
npm run test:live:for -- my-dev tests/live/cube.live.test.ts
npm run test:live:for -- my-dev --retry-login   # after fixing a refused login
```

- The `.env` goes through `connectionEnv()` in `src/connections.ts`, the same
  parse and `TM1_*` isolation the MCP server uses.
- One login probe runs before vitest, so a bad password costs one failed login
  rather than one per file.
- A refused probe (401/403) writes `.live-reports/<name>.auth-failed.log` and
  blocks further runs for that connection until `--retry-login` is passed. An
  unreachable server leaves no marker, since it never saw the credentials.

## Coverage is manual, not scheduled

Nothing runs these suites on a timer. Live coverage exists only while someone
runs them against a reachable server: the TM1 servers sit on a private network
that GitHub-hosted runners cannot reach. CI therefore proves the code is
self-consistent, not that TM1 still answers the way it did.

The recorded-fixture contract suite closes part of that gap without a server.
A live run can record the structure of real responses, which is then committed
and checked by the normal unit suite. See
[tests/fixtures/README.md](../fixtures/README.md) for the flow
(`npm run contracts:record`, `npm run contracts:verify`).

## Safety

Everything created is prefixed `ZZ_MCP_LIVE_<DOMAIN>` (`SANDBOX` in
`harness.ts`), and each file deletes its own objects in `afterAll`. The
`teardown` in `global-setup.ts` sweeps any leftovers after the run.

## Files

Helpers and infrastructure:

- `harness.ts` — connect, capture tool handlers, `call`/`ok`, REST fixtures, `sweepSandbox`
- `global-setup.ts` — vitest globalSetup; teardown sweeps leftovers and merges recorded contracts
- `contract-mode.ts` — `RECORD_CONTRACTS` flag and spool paths, shared by setup and recorder
- `contract-recorder.ts` — records wire responses while the suite runs
- `service-recorder.ts` — records service-method return shapes
- `merge-contracts.ts` — folds the recorder spools into `tests/fixtures/*.json`

Suites:

- `read-broad.live.test.ts` — broad read-only sweep over a real model
- `analysis.live.test.ts` — callgraph, object usage, feeder and cell-trace evidence, audit_complexity fan-out
- `compare.live.test.ts` — hierarchy structure paging, read against the live model
- `dimension.live.test.ts` — dimensions, hierarchies, elements, attributes, element batches, element search
- `element-refs.live.test.ts` — element-literal reference check: the TM1 behaviour it guards against
- `cube.live.test.ts` — cubes, cells, sample truncation, MDX, cube stats
- `rules-preflight.live.test.ts` — `tm1_set_cube_rules` preflight, rule outline and patch
- `view.live.test.ts` — native and MDX views, subsets
- `write-cells-address.live.test.ts` — `tm1_write_cells` address resolution
- `process.live.test.ts` — TurboIntegrator tools: upsert and deploy safety, compile, execute, diff, `.pro` files, git round trip
- `async-exec.live.test.ts` — TI runs as async operations: timeout, cancel, rollback
- `process-exit-status.live.test.ts` — process exit status mapping (`ProcessOutcome`)
- `process-backup.live.test.ts` — the automatic pre-overwrite backup restores cleanly
- `ignored-columns.live.test.ts` — datasource columns set to "Ignore"
- `chore.live.test.ts` — chore lifecycle
- `chore-exit-status.live.test.ts` — chore step exit status mapping
- `ops.live.test.ts` — server state, error log content, security reads, files
- `rest.live.test.ts` — `tm1_rest_read` / `tm1_rest_write` paths, guard refusals, monitoring reads
- `batch.live.test.ts` — `$batch` fallback probe and chunked bulk upserts; run on its own
- `v12-connection.live.test.ts` — v12 (Planning Analytics Engine) login and services

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
  on a TM1 error. Assert on `isError` or `json.code` for negative paths.
- `h.ok(name, args)` throws if the tool returned an error envelope. Use it for
  steps that must succeed.
- Prefix **every** created object with `${SANDBOX}_<DOMAIN>` and delete it in
  `afterAll`. The global sweep is a backstop, not a substitute.
- Build fixtures with the REST helpers: `createDimension(h, D, ["A", { name: "T", children: ["A"] }])`,
  `createCube(h, C, [D1, D2])` (TM1 needs at least two dimensions), `dropIfExists(h, seg("Cubes", C))`.
