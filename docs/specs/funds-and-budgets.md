# Funds, custody, budgets, and billing

Version: 1.0 design baseline. Owner: `packages/accounting`, enforced through API/executor. No wallets, assets, or payment services are created by this document.

## 1. Financial model

One **custodial wallet per agent**, provisioned through a wallet provider. A user may own multiple agents. Budget buckets are ledger accounts, not physical partitions of an ERC-20 balance. The platform controls signing, but the runtime and model do not. Keep custody ownership, user claims, on-chain inventory, provider invoices, and simulation balances distinct.

Accept one verified stablecoin `(chainId, contractAddress, decimals)` for initial live funding. Selection is an external capability gate, with Agora AUSD a candidate rather than a hardcoded promise. Native MON funds gas; wrapped native tokens and MON are different assets. Other tokens can enter approved trading inventory through swaps but are not automatically accepted for service bills. Unsupported deposits are quarantined for manual recovery, not sold or credited at an invented price.

On-chain accounting is per asset in atomic integer units. Display currency valuations never replace balances. Service billing uses a versioned rate card quoted in the accepted token's atomic units; any USD-to-token conversion is explicit, timestamped, and locked for the reservation. No assumption that a stablecoin always equals one dollar. Persist USD estimates separately using integer micro-USD, named `usdMicros`, and record price provenance.

## 2. Accounts and conservation

Double-entry journal accounts include `asset:agentWallet:<asset>`, `asset:treasury:<asset>`, `liability:user:unallocated:<asset>`, `liability:user:hosting:<asset>`, `liability:user:api:<asset>`, `liability:user:trading:<asset>`, and service revenue/refund accounts. Each account carries tenant/agent where applicable, asset, normal side, and mode. Entries are immutable; corrections are reversing journals. Every journal balances debits and credits **within each asset**, including multi-asset swaps.

The following six-decimal synthetic USD-token example uses display units for readability; implementation stores integer atomic units.

| Event | Debit | Credit |
| --- | --- | --- |
| Finalized deposit 100 | Wallet asset 100 | User unallocated liability 100 |
| Allocate 10 hosting, 20 API, 70 trading | Unallocated liability 100 | Hosting liability 10; API liability 20; trading liability 70 |
| Earn 0.20 API service charge | API liability 0.20 | Service revenue 0.20 |
| Sweep earned 0.20 to treasury | Treasury asset 0.20 | Agent-wallet asset 0.20 |
| Finalized withdrawal 5 of free trading funds | Trading liability 5 | Agent-wallet asset 5 |

A swap spends token A by debiting trading liability A and crediting wallet asset A; receives token B by debiting wallet asset B and crediting trading liability B. Charge actual native gas by debiting trading MON liability and crediting wallet MON asset. Approval transactions can spend gas even if a later swap fails. Taxes, platform margin and fees require disclosed separate line items before paid public use; do not bury them in trade P&L.

`available(bucket, asset) = credited liability balance - active reservations`. A bucket cannot become negative through application-initiated actions. Earned service revenue is no longer user liability but remains physically in the agent wallet until a policy-approved treasury sweep. Sweep only the earned amount, preserve all customer liabilities and holds, and never give the strategy a treasury-transfer action.

Reconcile finalized on-chain assets against recorded wallet assets and pending expected effects. Reconcile liabilities plus earned unswept amounts against those assets. Unexplained deficits, external wallet activity, fee-on-transfer behavior, or mismatched decimals freeze new live outflows and require investigation. The first release excludes rebasing and fee-on-transfer tokens. Receiving unsolicited tokens must not make them trusted.

## 3. Deposit and allocation

Create a deposit record at first observation with chain, token, sender, destination, transaction hash, log index, block hash and height. It is pending and unspendable. Credit once only when the receipt succeeds, the block is canonical and finalized, the token is accepted, and destination maps to that agent. A unique deposit event key prevents webhook/backfill duplicates. Speculative abandonment never requires reversing an already spendable provisional credit because provisional credit was never allowed.

Allocation is a user command with an expected budget version. In one short transaction, lock accounts in deterministic order, verify unreserved available balance, transfer liabilities, bump budget version, and record audit. Sum of assigned plus unallocated funds is conserved. No allocation changes previously committed charges or in-flight reservations. Increasing financial authority requires fresh user authentication and policy versioning, even if there is sufficient balance.

Operational stablecoin allocations cannot be spent by a swap. Token-in availability always comes from trading inventory. MON gas reserve is a visible sub-reservation of trading inventory, not a hidden fourth user bucket. Require native gas before live launch. Default MVP flow asks the user to fund the small MON reserve explicitly in the same funding step; an optional disclosed platform-sponsored bootstrap can simplify this later, but cannot assume a gasless account can buy its own first gas. Never silently exchange API/hosting balances to refill MON.

## 4. Reservations and concurrency

Reservation fields: ID, tenant/agent, bucket, asset, atomic ceiling, purpose, unique logical operation key, quote/rate/policy versions, created/expiry times, status, and settlement journal reference. One operation can reserve several assets atomically, such as swap token-in plus MON gas. Relevant account and spend-counter rows are locked in canonical order. Persist operation, reservation, counter holds and outbox in one transaction; never hold a DB transaction while waiting on a network call.

States: `held → dispatched → settled | released | reconciling`. `held` can expire only before external dispatch and after confirming no dispatch record. A dispatched timeout moves to reconciling. Settlement is unique per operation and returns unspent remainder. Duplicate completion returns the original result; conflicting completion freezes/reports rather than posting twice. Budget version alone is not a concurrency lock.

Atomic budget holds are authoritative. Privy's stateful policies explicitly update after successful signing and can allow concurrent requests before counters update; their documented role is disaster prevention rather than strict real-time caps. Use wallet-provider rules as defense in depth, plus our serialized signing and atomic holds. [Privy stateful policy semantics](https://docs.privy.io/controls/policies/stateful-policies)

Daily action counts and notional spend include pending reservations plus committed usage. Use UTC-day counters initially. Out-of-order settlement attaches usage to the authorization window; refunds/reverts release principal holds but preserve gas actually consumed. A new midnight counter cannot erase an old outstanding reservation. Global platform and tenant quotas are checked in the same admission path.

## 5. Three cost paths

### Model and paid data calls

Before dispatch, compute a conservative maximum from provider/model rate version, input tokens, output/reasoning cap, paid tool cost, and request count. Reject if the provider cannot enforce a bounded billable completion or the price is unknown. A call with provider-enforced caps should fit its hold; unexpected excess is a platform discrepancy, not authority to debit unrelated user buckets.

Record a dispatch attempt before sending, then provider request ID and reported usage. One attempt per AI node by default. A network timeout after send is an unknown charge: keep the hold, query provider usage if supported, or reconcile to later statements. Never automatically refund, redispatch or double charge. If usage remains unverifiable after 24 hours, pause additional calls for that profile, escalate, and settle at no more than the disclosed held maximum with evidence or release under the platform's refund policy. Platform absorbs unrecoverable billing uncertainty; no hidden indefinite customer hold.

Paper implementation 2026-10-13: [AI allowance reservations](../../apps/api/src/ai-allowance.ts) enforce the sandbox's 20-call/100,000-micro-USD UTC-day limits and the saved API allocation, independently of trading/hosting. This is virtual paper accounting, not a custodial token ledger. Unknown calls retain their original-window hold; identical-operation replay cannot reserve or dispatch again. Earlier charges/holds are preserved by migration 0015, with pre-dispatch refusal counts corrected by 0017. [Allowance and recovery evidence](../../tests/ai-allowance.test.ts).

### Hosting

Sell a disclosed resource-profile rate per billable time slice, not guessed per-process CPU usage. Reserve the next 60-second slice before extending a compute lease. Include minimum billing, startup/image pull, shared control-plane/network/storage costs and documented margin in the published rate. Use monotonic provider timestamps/resource IDs to avoid duplicated slices after restart. Stop before a new slice if funds are insufficient; teardown tail costs beyond the last authorized slice are platform responsibility.

The quote shows shared overhead and idle behavior. An API-heavy workflow can still need an always-on runtime; AI use does not make hosting free. A non-AI strategy does not inherently need more CPU; choose profiles from bounded runtime measurements and event volume. Cloud provider invoices and customer charges are separate records reconciled by resource/run IDs and tags.

### Trades and gas

Reserve exact input and a maximum native gas ceiling, including any required approval. Freeze input amount and allowed output asset/recipient for the intent. Quote expiry, min output, route/calldata, reference price deviation and policy are checked immediately before signing. Finalized reverted trades release input holds and charge actual gas; successful trades post actual observed asset changes. Unsupported token behavior triggers a reconciliation hold.

Platform-sponsored gas, if introduced, uses a separate platform budget and per-user abuse cap. It must not appear as free user MON or disguise a trading cost. Failed simulation incurs no chain gas, but may incur a disclosed paid data/RPC charge only if that capability was selected.

## 6. Runway recommendation

Inputs: total accepted deposit D, desired operating days T, minimum trading allocation K, gas estimate G, active hours/profile rate, event/schedule frequency, statically bounded AI calls per run, input/output maxima, paid data calls, observed historical usage when available, and margin m. All amounts are converted through a timestamped quoted rate before comparison.

Estimate hosting h and API a **per day** at the selected settings. Required operating allocation is `H = ceil(T × h × (1+m))`, `A = ceil(T × a × (1+m))`; proposed trading allocation is `D − H − A`, of which G is earmarked for gas. If that is below K+G, report infeasibility and offer shorter T, fewer events/calls, or a cheaper supported profile/model. Do not silently cut the requested trading minimum.

For a fixed operating pool O = D−K−G and positive daily rates, a balanced suggestion assigns `O×h/(h+a)` to hosting and `O×a/(h+a)` to API. Expected runtime is the minimum of the two funded category runtimes. When a=0, API allocation may be zero and that category does not constrain runway. Unknown/event-unbounded rates require user-set frequency/call caps before any estimate. Show expected and upper-bound consumption; trading P&L is excluded.

**Illustrative arithmetic, not provider pricing:** D=100, K=70, G=1, h=1/day and a=0.5/day leaves O=29. Without margin it suggests hosting 19.33 and API 9.67 (rounding reconciled to exactly 29), about 19.3 operating days. A 20% usage margin reduces the estimate to about 16.1 days. This predicts neither trading returns nor time until trading losses exhaust K.

Rate-card/version, timestamp, expiry (five minutes by default), assumptions and rounded allocations are displayed and stored. A changed strategy, model, interval, connector, or profile invalidates the quote. Re-estimation is advisory; budget reallocation always needs explicit user action.

## 7. Withdrawals, refunds and settlement

Withdrawals require an authenticated owner, step-up verification, explicit asset/amount/destination, and idempotency key. Default destination is a verified owner address; changing it invalidates prior approval. Lock the same accounts used for trade reservations, reserve withdrawal plus gas, and execute through the transaction gateway. Already-reserved funds are unavailable. User may pause to drain activity and withdraw the free remainder; do not require the strategy runtime to be healthy for withdrawal.

Full exit cancels undispatched intents, reconciles dispatched effects, optionally converts inventory only with separate user consent, withdraws available assets, and keeps enough disclosed MON for final fees. Outstanding allowances need a revocation plan; stopping compute alone does not revoke a token allowance. An unavailable provider results in pending/blocked withdrawal, never a fabricated success.

Unused operating funds are refundable user liabilities. Posted charges can be refunded through explicit reversal/credit journals. No deletion of history. Treasury sweeps and vendor fiat settlement require platform operational accounts and verified commercial terms. A crypto deposit is not direct AWS/Kimi/Qwen payment; the baseline uses the platform's vendor accounts. x402 paid data is optional and needs the same reservation/recipient checks.

Before public custody: confirm provider terms, accounting treatment, jurisdictional obligations, customer disclosures, refund/insolvency procedures, signer ownership/recovery, and an accountable operator. This is an engineering release gate, not a determination of legal status.

## 8. Required checks

Prove two simultaneous calls cannot overspend; atomic multi-asset reservation rollback; balanced per-asset journals; duplicate deposits/settlements produce one posting; speculative deposits stay unspendable; withdrawal conflicts with pending trade; unknown model billing stays held then resolves; hosting teardown overruns are not charged outside authorization; earned treasury sweep preserves liabilities; and reconciliation mismatch freezes outflows. See [verification](verification.md).
