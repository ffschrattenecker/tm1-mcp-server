<!-- Thanks for contributing! Keep PRs focused and small where possible. -->

## Summary

<!-- What does this change and why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature / tool
- [ ] Refactor (no behavior change)
- [ ] Docs only

## Checklist

- [ ] `npm run verify` passes (typecheck, lint gates, full test suite)
- [ ] Tests added/updated for the change
- [ ] New TM1 REST calls go through a service under `src/tm1-client/services/` (not flat client methods)
- [ ] New tools are built with `defineTool()` (`src/tools/define-tool.ts`) and declare annotations + an output schema in the spec
- [ ] Docs/README updated if behavior or tool surface changed
- [ ] No secrets, credentials, or internal paths committed
