# Continuous integration

Own GitHub Actions workflows. Read [design policy](../design.md) for pinning and evidence rules and [infra](../infra/AGENTS.md) for operational ownership. Writable by the integration lead; workflow changes are reviewed like shared contracts.

Pin every third-party action to a full commit SHA with the release tag in a comment. Default `permissions: contents: read`; widen per job only with a stated reason. CI uses synthetic fixtures and no repository secrets, provider credentials, wallets or deployment authority. Paid-provider, live-fund and deployment jobs need separate explicit authorization.

## Checklist

- [ ] CI-1 / G1: run frozen install and `pnpm check` on pushes to `master` and on pull requests with pinned Node, pnpm and actions. Progress: [ci.yml](workflows/ci.yml) written; the same steps passed locally on 2026-10-02 (Node 24.21.0, pnpm 12.8.1, 4/4 tests). Tick after the first hosted run is green and linked.
- [ ] CI-2 / G1: add schema/fixture validation and Postgres-backed checks once contracts and migrations exist.
  - Progress 2026-10-02: [ci.yml](workflows/ci.yml) adds a digest-pinned Postgres 17.11 service, runs migrations twice plus the seed, and sets `REQUIRE_DB=1` so database tests cannot skip. The same steps passed locally on a fresh database on 2026-10-02; `pnpm bootstrap` passed again on 2026-10-03 (244/244). Tick after the first hosted run is green and linked.
