# Control plane and provider broker

Own authenticated HTTP/SSE routes, tenant authorization, drafts/catalog/revisions, lifecycle/provisioning jobs, event ingestion, model/data broker and usage coordination. Read [API/data](../../docs/specs/api-and-data.md), [runtime](../../docs/specs/runtime.md), and [security](../../docs/specs/security.md). For billing read [funds](../../docs/specs/funds-and-budgets.md); for providers read [sponsor research](../../docs/research/sponsors.md).

Use Fastify/Node and explicit Postgres transactions. API worker is a process role here. No signing credential or raw signing route. Derive scope from auth, reserve billable work through accounting, use immutable revisions, and keep state/outbox changes atomic. Network calls happen outside DB transactions. Model timeouts can mean unknown charges.

Own migrations by agreement with the data owner; never let parallel writers independently assign migrations. Runtime capabilities are narrow, short-lived and revocable.

## Checklist

- [ ] API-1 / G1,G3: implement schemas, migrations, authentication, tenant constraints, idempotency and optimistic draft edits.
  - Progress 2026-10-02: schemas via `@monad-hack/contracts`; [migration runner](src/db/migrate.ts) with checksums and an advisory lock; [0001 baseline](migrations/0001_g1_baseline.sql) (catalog, tenants, agents, revisions, policies, estimates) with composite tenant keys, UUIDv7 checks and immutability triggers; synthetic [paper seed](src/db/seed.ts); [db.test.ts](src/db/db.test.ts) proves cross-tenant references fail. Evidence: `pnpm bootstrap` (Node 24.21.0, pnpm 12.8.1, Postgres 17.11) → 244/244 node:test pass, 0 skipped, re-run 2026-10-03 after merging with the language core. Remaining (G3): authentication, idempotency records, optimistic draft edits.
  - G1 portion done 2026-10-03 (commit `5d94ea3`, green hosted CI): schemas, migrations and tenant constraints. Remaining (G3): authentication, idempotency, optimistic draft edits.
- [ ] API-2 / G3: implement catalog resolution, server strategy validation, immutable manifests and lifecycle transitions.
  - Progress 2026-10-12 (branch `feat/lifecycle-executor-integration`): paper lifecycle in [lifecycle.ts](src/lifecycle.ts): estimates (policy v1 from experience), `deployment/1` launch with manifest, simulation account and catalog/capability validation, pause/resume/stop, operations ([D37](../../docs/decisions.md), [D39](../../docs/decisions.md)); migration [0005](migrations/0005_deployment_lifecycle.sql). Evidence: [paper-stack.test.ts](../../tests/paper-stack.test.ts) under `REQUIRE_DB=1 pnpm check` 518 pass. Remaining: catalog resolution beyond the synthetic catalog, cloud provisioning operations (INF-3), live launches.
- [ ] API-3 / G3–G4: implement leased/fenced jobs, cloud operation reconciliation, durable event ingestion and backfill.
  - Progress 2026-10-08 (branch `feat/runtime-control-api`): runtime-facing control API in [runtime-control/](src/runtime-control/) with [migration 0003](migrations/0003_runtime_control.sql): fenced leases and per-assignment capabilities, checkpoint-before-dispatch wait/result/complete/timeline, heartbeat, long-poll, trigger_state fan-out with `transitionPrice`, schedule ticks, resume after pending results, revoke-on-resume, lease reclaim. Evidence: [runtime-control.test.ts](../../tests/runtime-control.test.ts) (conformance kit against the store and through HTTP, 8 end-to-end paper scenarios) under `REQUIRE_DB=1 pnpm check` 426 pass. Remaining: real ingestion source (E10), production workload identity (E02), cloud operation reconciliation.
- [ ] API-4 / G5: integrate budget allocation, quotes and hosting lease metering through accounting.
- [ ] API-5 / G6: implement Kimi capability mapping, bounded AI requests, usage/unknown-charge recovery; add Qwen only with parity checks.
- [ ] API-6 / G7: expose durable audit history, resumable SSE, pause/revoke and failure reasons.
  - Progress 2026-10-12: `audit-event/2` stream written with every run/deployment change and published from `executor_outbox`; run history, run detail, paginated events and resumable SSE (`/v1/agents/{id}/stream`) ([D40](../../docs/decisions.md)). Pause/stop revoke authority immediately. Remaining: failure-reason vocabulary review with product, retention and stream reset instruction.
- [ ] API-7 / G3–G8: pass tenant, duplicate launch, stale generation, paid-call and webhook replay checks.

Dependencies: [contracts](../../packages/contracts/AGENTS.md), [accounting](../../packages/accounting/AGENTS.md), [connectors](../../packages/connectors/AGENTS.md). After API-2/3, [runtime](../runtime/AGENTS.md) can integrate lifecycle. Tick only with implementation and passing evidence.

Progress 2026-10-08 (`codex/user-app-control-api`): local Fastify routes, server compilation, exact virtual-budget configuration checks, tenant-scoped immutable revision saves and transactional response replay are implemented. Real Postgres tests cover concurrency, ownership, reload, pagination and suspended tenants. Hosted identity and lifecycle jobs remain pending; see [slice evidence](../../plan.md#local-control-workspace--2026-10-08).

## Broker-AI issue evidence

- [x] BROKER-1 / #4: immutable persisted answers, scoped result-ID read contract, durable dispatch claims and identical-operation replay. Migration 0006; [persistence tests](src/broker-store.test.ts) and [migration checks](src/db/db.test.ts). Evidence 2026-10-13: `REQUIRE_DB=1 pnpm check` 525 passed, zero skipped. HTTP/provider integration remains #5.

- [x] BROKER-2 / #5: paper broker HTTP route, broker-audience exchange with current-assignment checks, immutable replay, recorded read freshness, declared AI output validation and durable reconciliation resume. [Service conformance/safety tests](../../tests/broker-service.test.ts) and [kit](../runtime/src/conformance/broker.ts). Evidence 2026-10-13: `REQUIRE_DB=1 pnpm check` 534 passed, zero skipped. Synthetic model only; provider integration remains #8.

- [x] BROKER-5 implementation / #8: bounded Kimi adapter, broker-only credentials, durable token/rate holds and unknown-charge reconciliation implemented. [Integration/evidence guide](../../docs/integration/kimi-broker.md), [adapter tests](src/kimi-adapter.test.ts), [PostgreSQL tests](../../tests/kimi-broker.test.ts). E05 and API-5 remain open until an authorized real account/billing probe; paid dispatch defaults disabled. `REQUIRE_DB=1 pnpm check`: 558 passed, zero skipped (2026-10-13).
