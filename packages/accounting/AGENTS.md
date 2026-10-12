# Accounting and reservations

Own per-asset ledger posting, available-balance calculation, atomic reservations, rate-card/cost arithmetic, spend-window counters and reconciliation helpers. Read the complete [funds specification](../../docs/specs/funds-and-budgets.md), related tables in [API/data](../../docs/specs/api-and-data.md), and [verification](../../docs/specs/verification.md).

One financial authority for API billing and executor spending. Exact integer arithmetic only; immutable balanced journals; corrections through reversals. Available excludes holds. Dispatched unknown effects cannot expire like undispatched holds. Trading/hosting/API accounts and paper/live identities never leak into each other. Use short transactions and deterministic lock order; no provider calls inside DB transactions.

## Checklist

- [x] ACC-1 / G5: implement per-asset accounts, balanced posting and idempotent settlement constraints.
  - Done 2026-10-12: migration `0006` (posting trigger, deferred per-asset balance check, immutable journals), [`ledger.ts`](src/ledger.ts); raw-SQL bypass, duplicate and concurrent-duplicate checks in [accounting.test.ts](../../tests/accounting.test.ts).
- [x] ACC-2 / G5: implement atomic multi-asset reservation, release and unknown-outcome reconciliation.
  - Done 2026-10-12: [`reservations.ts`](src/reservations.ts) (`held → dispatched → settled | released | reconciling`, conflict freeze D43); concurrent overspend fails in 5/5 rounds, multi-asset rollback, expiry only before dispatch.
- [x] ACC-3 / G5: implement allocation/versioning, available balance and daily counter holds.
  - Done 2026-10-12: [`allocation.ts`](src/allocation.ts), UTC-day `spend_windows` with pending holds attached to the authorization day; API with step-up in [funds-api.test.ts](../../tests/funds-api.test.ts).
- [x] ACC-4 / G5–G6: implement rate cards, model/compute metering, runtime estimates and refund rules.
  - Done 2026-10-12: [`rates.ts`](src/rates.ts) (spec §6 example as oracle), [`metering.ts`](src/metering.ts) (hosting slices D44, worst-case model holds, unknown → 24 h escalation → resolve ≤ hold), refunds via `refundPostings`. Real prices pending E05 / provider quotes (placeholders only).
- [ ] ACC-5 / G8: implement finalized deposit/swap/gas/withdrawal/sweep journal operations.
  - Progress 2026-10-12: operations, finalized deposits and withdrawals done against the local chain ([custody.test.ts](../../tests/custody.test.ts)); open for real-chain evidence (E04/E06, G8).
- [ ] ACC-6 / G5–G10: pass concurrent overspend, conservation, duplicate settlement and deficit-freeze checks.
  - Progress 2026-10-12: all four pass for G5 (accounting, custody and funds-api tests); G10 operational evidence remains.

Prerequisites: [contracts](../contracts/AGENTS.md) and coordinated API migrations. Consumers are [API](../../apps/api/AGENTS.md) and [executor](../../apps/executor/AGENTS.md). Tick with database-backed evidence; no mocked arithmetic-only claim for concurrency safety.
