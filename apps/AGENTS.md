# Application roots

Scope: independently started processes and website builds. Read [architecture](../architecture.md) before introducing another app. Children inherit root instructions and own their process-specific work.

`web` owns user interaction; `api` owns control/lifecycle and provider brokers; `runtime` interprets restricted strategies; `executor` owns financial effects; `docs` builds public user docs. API workers are roles within the API app, not new app directories. No app imports another app's source; share a real contract/package instead.

## Checklist

- [ ] APPS-1 / G1: define distinct start/build/test entries only when implementation begins.
  - Progress 2026-10-02 (`master`): private ESM stub manifests for all five apps, covered by the root `pnpm check`. They have no scripts yet because no app has an entry point. Remaining: per-app start/build/test entries once each app has source.
  - Progress 2026-10-03 (`master`, G2 editor Phase 2): `apps/web` has Vite/React `dev`, `build`, `typecheck` and `test:e2e` (Playwright, `*.spec.ts`) scripts; root `pnpm check` typechecks it and `pnpm web:dev` starts it. Remaining: api, runtime, executor and docs entries.
  - Progress 2026-10-03: `apps/api` has its first source (config, migration runner, paper seed, DB tests), run through root `pnpm db:*`/`pnpm check`; still no server start entry (G3).
  - G1 portion done 2026-10-03 (commit `5d94ea3`, green hosted CI): entries exist for every app with source (`apps/web` scripts; `apps/api` via root `pnpm db:*`). Remaining: start entries for api, runtime, executor and docs as each gets source.
  - Progress 2026-10-07: `apps/runtime` has source and `pnpm runtime:demo` (root) / `pnpm --filter @monad-hack/runtime demo`; its tests run in root `pnpm check`. Its process entry (`main.ts` with HTTP clients) arrives with the first real service.
  - Progress 2026-10-08: `apps/executor` has source and tests in root `pnpm check`; its process entry waits for the control API's deployment authority (see [executor checklist](executor/AGENTS.md)).
- [ ] APPS-2 / G4: prove process credentials/network access match architecture.
- [ ] APPS-3 / G7–G8: verify the end-to-end contracts across apps without private source imports.

Prerequisites: [contracts](../packages/contracts/AGENTS.md) before app integration. Tick after passing checks and link evidence; individual features remain in child checklists.
