# Integration guides

Scope: how another service owner integrates with an implemented component. A guide is a how-to that links to the normative [specifications](../specs/) and [contracts](../../packages/contracts/schemas/) for rules; it does not restate limits or redefine a contract. When a guide and a spec disagree, the spec and schema win; fix the guide in the same change.

Every guide names the conformance kit that proves an integration and keeps its examples equal to contract fixtures or tested vectors.

Funds, custody and withdrawals: [funds.md](funds.md) (G5, track #29).

## Checklist

- [x] INT-0 / G4: build the runtime HTTP clients and `main.ts` per [runtime HTTP clients](runtime-http-clients.md), proven first against a loopback server wrapping the stand-ins.
  - Done 2026-10-13: all three clients validated against real services; broker conformance in [broker-service.test.ts](../../tests/broker-service.test.ts), launch-to-history flow in [paper-stack.test.ts](../../tests/paper-stack.test.ts). `REQUIRE_DB=1 pnpm check`: 542 passed, zero skipped; `pnpm stack:dev` boots with the HTTP broker.
  - Progress 2026-10-12: control API and executor clients and `main.ts` done and proven against the real services; open until the broker client exists.
- [x] INT-1 / G4: control API owner passes the [control API conformance kit](../../apps/runtime/src/conformance/control-api.ts) against the real service through the runtime HTTP client.
  - Done 2026-10-08 (branch `feat/runtime-control-api`): kit green through `HttpControlApi` → internal Fastify app → PostgreSQL in [runtime-control.test.ts](../../tests/runtime-control.test.ts); `REQUIRE_DB=1 pnpm check` 426 pass, 0 skipped. Hosted deployment is separate (INF-3).
- [x] INT-2 / G4: executor owner passes the [executor conformance kit](../../apps/runtime/src/conformance/executor.ts) against the paper executor through the runtime HTTP client.
  - Done 2026-10-12 (branch `feat/lifecycle-executor-integration`): kit 7/7 through the runtime's `HttpExecutor` against the real paper executor on PostgreSQL ([executor-conformance.test.ts](../../tests/executor-conformance.test.ts)); end to end with Postgres authority and control-API-issued capabilities in [paper-stack.test.ts](../../tests/paper-stack.test.ts). `REQUIRE_DB=1 pnpm check` 518 pass, 0 skipped.
  - Rehearsal 2026-10-08: kit 7/7 against the real paper executor over HTTP and PostgreSQL through a test-only client applying the [§3 mapping](runtime-http-clients.md#3-one-error-mapping-both-sides-implement-it) ([`tests/executor-conformance.test.ts`](../../tests/executor-conformance.test.ts)). Not ticked: needs the runtime client (INT-0) and control-API authority.

Tick only with a linked passing run against the real service; the local stand-ins passing their own kits is not integration evidence.
