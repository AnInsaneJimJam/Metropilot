# Accounting and reservations

Own per-asset ledger posting, available-balance calculation, atomic reservations, rate-card/cost arithmetic, spend-window counters and reconciliation helpers. Read the complete [funds specification](../../docs/specs/funds-and-budgets.md), related tables in [API/data](../../docs/specs/api-and-data.md), and [verification](../../docs/specs/verification.md).

One financial authority for API billing and executor spending. Exact integer arithmetic only; immutable balanced journals; corrections through reversals. Available excludes holds. Dispatched unknown effects cannot expire like undispatched holds. Trading/hosting/API accounts and paper/live identities never leak into each other. Use short transactions and deterministic lock order; no provider calls inside DB transactions.

## Checklist

- [ ] ACC-1 / G5: implement per-asset accounts, balanced posting and idempotent settlement constraints.
- [ ] ACC-2 / G5: implement atomic multi-asset reservation, release and unknown-outcome reconciliation.
- [ ] ACC-3 / G5: implement allocation/versioning, available balance and daily counter holds.
- [ ] ACC-4 / G5–G6: implement rate cards, model/compute metering, runtime estimates and refund rules.
- [ ] ACC-5 / G8: implement finalized deposit/swap/gas/withdrawal/sweep journal operations.
- [ ] ACC-6 / G5–G10: pass concurrent overspend, conservation, duplicate settlement and deficit-freeze checks.

Prerequisites: [contracts](../contracts/AGENTS.md) and coordinated API migrations. Consumers are [API](../../apps/api/AGENTS.md) and [executor](../../apps/executor/AGENTS.md). Tick with database-backed evidence; no mocked arithmetic-only claim for concurrency safety.
