# Control plane and provider broker

Own authenticated HTTP/SSE routes, tenant authorization, drafts/catalog/revisions, lifecycle/provisioning jobs, event ingestion, model/data broker and usage coordination. Read [API/data](../../docs/specs/api-and-data.md), [runtime](../../docs/specs/runtime.md), and [security](../../docs/specs/security.md). For billing read [funds](../../docs/specs/funds-and-budgets.md); for providers read [sponsor research](../../docs/research/sponsors.md).

Use Fastify/Node and explicit Postgres transactions. API worker is a process role here. No signing credential or raw signing route. Derive scope from auth, reserve billable work through accounting, use immutable revisions, and keep state/outbox changes atomic. Network calls happen outside DB transactions. Model timeouts can mean unknown charges.

Own migrations by agreement with the data owner; never let parallel writers independently assign migrations. Runtime capabilities are narrow, short-lived and revocable.

## Checklist

- [ ] API-1 / G1,G3: implement schemas, migrations, authentication, tenant constraints, idempotency and optimistic draft edits.
- [ ] API-2 / G3: implement catalog resolution, server strategy validation, immutable manifests and lifecycle transitions.
- [ ] API-3 / G3–G4: implement leased/fenced jobs, cloud operation reconciliation, durable event ingestion and backfill.
- [ ] API-4 / G5: integrate budget allocation, quotes and hosting lease metering through accounting.
- [ ] API-5 / G6: implement Kimi capability mapping, bounded AI requests, usage/unknown-charge recovery; add Qwen only with parity checks.
- [ ] API-6 / G7: expose durable audit history, resumable SSE, pause/revoke and failure reasons.
- [ ] API-7 / G3–G8: pass tenant, duplicate launch, stale generation, paid-call and webhook replay checks.

Dependencies: [contracts](../../packages/contracts/AGENTS.md), [accounting](../../packages/accounting/AGENTS.md), [connectors](../../packages/connectors/AGENTS.md). After API-2/3, [runtime](../runtime/AGENTS.md) can integrate lifecycle. Tick only with implementation and passing evidence.
