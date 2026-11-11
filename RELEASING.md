# Releasing

Trunk-based flow: work lands on `main` continuously; a release is a separate,
deliberate "cut" step. **Merging work and cutting a release are decoupled.**
Do not pick a version, bump `package.json`, or create a tag until you actually
publish — the version (patch/minor/major) is decided at release time from the
accumulated `[Unreleased]` changes.

## During development

- Small feature branch → `npm run verify` green → fast-forward merge to `main`.
- Every user-visible change adds a bullet under `## [Unreleased]` in
  `CHANGELOG.md` (Keep a Changelog: `### Added` / `### Changed` / `### Fixed` /
  `### ⚠️ Behavior change` / `### Security`). Internal-only tooling changes may
  be omitted.
- `main` stays releasable at all times. Unpushed/unreleased commits on `main`
  are normal — they are not a release until you cut one.
- Run `npm install` once per clone. Its `prepare` step points git at
  `.githooks/`, so every `git push` first runs `npm run verify` and the tarball
  smoke test: the same steps CI runs. A push that would fail CI is stopped on
  your machine. Bypass only deliberately with `git push --no-verify`.
- **Never** create the version tag or bump `package.json` mid-stream. That is
  what forces `git tag -f` later.

## Cutting a release

Everything that can change files or fail happens BEFORE the tag: pushing the
tag publishes.

1. **Decide the version** from what sits under `[Unreleased]` (semver):
   - `patch` — fixes only, no new tools/behavior.
   - `minor` — new tool or capability, backward-compatible.
   - `major` — breaking change to a tool's contract.
2. **Refresh the tool list** if tools changed: `npm run tools:update-readme`
   (regenerates `docs/TOOLS.md` and the category table in `README.md`). Commit.
3. **Finalize the changelog:** rename `## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`,
   add a fresh empty `## [Unreleased]` above it, and update the compare links at
   the bottom (`[Unreleased]: …/compare/vX.Y.Z...HEAD` and a new
   `[X.Y.Z]: …/compare/vPREV...vX.Y.Z`). Commit.
4. **Smoke-test the tarball:** `npm run smoke:tarball` — packs the real tarball,
   installs it into a throwaway project under `os.tmpdir()`, and drives the
   installed binary: the `bin` entry, the shebang, the `files` allow-list, the
   shipped `npm-shrinkwrap.json` and an unconfigured start. CI and the publish
   workflow run it too.
5. **Push `main` and wait for CI to go green.** It runs the same `verify` gate
   as the publish workflow, so a green CI means the tag will not fail on it.
   If `publish-npm.yml` changed since the last release, also run it once with
   **dry-run** checked on `main` (Actions → Publish to npm → Run workflow): a
   broken workflow otherwise costs a version number.
6. **Bump + tag atomically:** `npm version <patch|minor|major>` — this bumps
   `package.json`, commits, and creates the `vX.Y.Z` tag in one step (no manual
   tagging, no `git tag -f`).
7. **Push — this publishes:** `git push --follow-tags origin main` runs
   `.github/workflows/publish-npm.yml`. Its `build` job checks the tag against
   `package.json` and that the tagged commit is on `main`, runs `verify` and
   the smoke test, and packs the tarball; its `publish` job (the only
   one holding `id-token`) publishes that tarball with provenance, authenticated
   via npm trusted publishing (OIDC — no token; configured under the package's
   Settings → Trusted Publisher on npmjs.com).
8. **Confirm it published:** a run for the tag must appear under Actions, and
   `npm view @ffschrattenecker/tm1-mcp-server dist-tags` must show the new
   version. If the tag push never triggered a run, start the workflow manually
   (Actions → Publish to npm → Run workflow, **ref = the tag**).
9. **Optional:** a GitHub release for the `vX.Y.Z` tag, with the changelog section as the body.

## Never move a pushed tag

- A `vX.Y.Z` tag that has been pushed is immutable. Do not `git tag -f`, delete
  and re-push it, or `git push --force` a tag. Other clones and the GitHub
  record may already hold it.
- **When a publish fails, the next step is always a new patch version**, never
  a moved tag. Fix the problem on `main`, run `npm version patch`, and push the
  new tag. The failed tag stays where it is. Note the skipped version in the
  next changelog entry, as 10.5.1 did for 10.5.0.
- If the tag exists but the publish never started, re-run the workflow
  manually on that tag (step 8). That does not move anything.

## Guardrails already wired

- `.githooks/pre-push` — runs `npm run verify` and `smoke:tarball` before any
  push leaves the machine (see _During development_).

- `prepack` (`rm -rf dist && npm run build`) — clean tarball, no stale `dist/`
  cruft. Runs on `npm pack` and `npm publish`.
- `prepublishOnly` (`npm run verify`) — publish aborts if the full gate
  (typecheck + lints + tests) is not green.
- `npm-shrinkwrap.json` (not `package-lock.json`) — it is published and
  pins the whole dependency tree for consumers, so lockfile security fixes
  actually reach `npx` users. Keep it committed; `npm install` updates it.
- `files: ["dist", "!dist/**/*.map", "NOTICE", "npm-shrinkwrap.json"]` — only
  compiled output (no source maps or typings; this is a bin-only package) plus
  the licence notice and the shrinkwrap ship; source, tests, docs, and secrets
  never do. `smoke:tarball` asserts this held by listing the
  real tarball, since a broken `files` entry is how credentials reach npm.
