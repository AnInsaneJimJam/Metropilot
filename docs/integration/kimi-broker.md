# Kimi broker integration

The adapter is implemented and tested with synthetic transport. **E05 remains open: no paid provider call or account billing verification was performed.** The user explicitly requested that gate remain closed. Normal `stack:dev` keeps its synthetic profile; there is no automatic model substitution.

Only the control/broker process receives `KIMI_API_KEY`. Runtime and executor environments exclude it. Real calls require a `KIMI_VERIFICATION_FILE`, supplied outside Git, containing exactly these fields:

- `model`: `kimi-k2.6`
- `rateVersion`: `kimi-k2.6-2026-10-13`
- `inputUsdMicrosPerMillion`: `"950000"`
- `cachedInputUsdMicrosPerMillion`: `"160000"`
- `outputUsdMicrosPerMillion`: `"4000000"`
- `boundedBillingVerified`: `true`, only after an authorized real probe
- `verifiedAt`: UTC timestamp, at most seven days old
- `evidenceRef`: bounded reference to the actual model/request/billing evidence

The immutable deployment catalog must explicitly pin a paper Kimi provider profile with this exact model and version `1.0.0`. The synthetic `paper.kimi` profile remains synthetic. Enabling a paid profile requires separate user authorization and real account evidence; presence of an API key alone enables nothing.

## Published evidence — 2026-10-13

The [official pricing table](https://platform.kimi.ai/docs/pricing/chat) publishes K2.6 input/cache-hit/output rates of USD 0.95/0.16/4.00 per million tokens, excluding applicable taxes. These are published rates, not an observed invoice. The [model guide](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart) supports disabling thinking. The [chat reference](https://platform.kimi.ai/docs/api/chat) documents JSON mode, completion caps and usage fields. Its parameter name is `max_completion_tokens`; the [thinking guide](https://platform.kimi.ai/docs/guide/use-thinking-models) also documents the older `max_tokens` cap. A real probe must confirm the exact accepted parameter and billed bound for the selected account.

The request disables thinking, tools and streaming, asks for one JSON response, caps output at the strategy limit and enforces its timeout. Input uses a conservative UTF-8 byte bound plus 512 framing tokens, capped at 8,192; E05 must verify this framing/token assumption. Unexpected usage, model identity, cache-write charges or completion bounds keep the bill unknown. Taxes/platform fees require a separately disclosed rate card before public billing.

## Durable metering and recovery

Migration 0007 records the original operation, rate snapshot, token ceilings and maximum micro-USD hold **before provider I/O**. There is one provider attempt. Valid reported usage settles once, even when model output is rejected. Missing/invalid usage, timeout or interrupted dispatch retains the hold; no automatic retry or refund occurs. An unresolved bill older than 24 hours blocks further calls to that model profile pending operator reconciliation.

`KimiBroker.reconcileUsage()` is a privileged in-process operation requiring original provider identity, independently verified token usage and an evidence reference. It cannot authorize a missing model decision. `recover()` publishes the durable original result after a crash, or a safe refusal after billing-only reconciliation. It never calls the provider. No runtime-accessible reconciliation endpoint exists.

Evidence: [adapter checks](../../apps/api/src/kimi-adapter.test.ts), [PostgreSQL metering/replay/reconciliation scenarios](../../tests/kimi-broker.test.ts), [migration checks](../../apps/api/src/db/db.test.ts). Issue #9 enforces the paper allowance through [AiAllowance](../../apps/api/src/ai-allowance.ts): 20 calls and 100,000 micro-USD per UTC day, further bounded by the configured API allocation. Claims serialize on the agent row across runs/deployments. Unknown holds survive midnight against that allocation; settlement stays in the original authorization window. Synthetic calls count toward the call limit and settle at zero. Migration 0009 backfills earlier charges, holds and synthetic calls; apply all migrations before starting services. Trading and hosting allocation are never debited. [PostgreSQL allowance/runtime replay tests](../../tests/ai-allowance.test.ts) prove these boundaries.
