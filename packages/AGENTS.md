# Shared modules

Packages exist for real app consumers or connector distribution. Read [design policy](../design.md) before adding a package. Apps depend on packages; packages never import app source. Maintain browser-safe exports separately from DB/network/signing-related code.

`contracts` owns shapes; `strategy` owns language; `accounting` owns conservation/holds; `policy` owns deterministic decisions; `connectors` owns protocol capabilities. Avoid generic shared/utils modules and speculative factories.

## Checklist

- [x] PKG-1 / G1: establish dependency direction, exports and schema-derived types.
  - Done 2026-10-02: [workspace.test.ts](../tests/workspace.test.ts) enforces exact versions and packages→never→apps; `@monad-hack/contracts` (the only package with source) has an `exports` map and generated types consumed by `apps/api`. Evidence: `pnpm bootstrap` (Node 24.21.0, pnpm 12.8.1, Postgres 17.11) → 244/244 node:test pass, 0 skipped, re-run 2026-10-03 after merging with the language core. Other packages add `exports` with their first source.
  - Progress 2026-10-02 (`master`): private ESM stub manifests for all five packages. [tests/workspace.test.ts](../tests/workspace.test.ts) fails if a package depends on an app or uses a non-exact external version. Remaining: `exports` maps (added with first source) and schema-derived types (CON-1).
  - Progress 2026-10-02 (`master`, uncommitted): `@monad-hack/contracts` has an `exports` map (`.` → `src/index.ts`, `./schemas/*.json`) and schema-derived types (CON-1). Pinned deps: ajv 8.20.0, ajv-formats 3.0.1, dev json-schema-to-typescript 16.0.0. `pnpm check` passes. Remaining: `exports` for the other four packages when they get source; a build step if a consumer cannot load `.ts` exports.
- [ ] PKG-2 / G2–G6: verify pure modules through their public interfaces and money modules against Postgres.
- [ ] PKG-3 / G7–G8: prove browser bundles exclude secrets/server dependencies and consumers use one contract version.

Child checklists own feature status. Tick integration tasks only with evidence and notify the integration owner for root gates.
