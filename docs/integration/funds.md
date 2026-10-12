# Funds, budgets, custody and withdrawals (G5)

How the funds and policy track (#29) is built, how to run it, what each consumer calls, and what still needs
accounts. Normative rules stay in [funds-and-budgets.md](../specs/funds-and-budgets.md),
[executor.md §6](../specs/executor.md#6-policy-contract-and-denial-reasons) and [decisions D42–D46](../decisions.md).

## 1. What exists

| Piece | Where | Proven by |
| --- | --- | --- |
| Per-asset double-entry ledger, reversals, freezes, reconciliation | `packages/accounting` (`ledger.ts`, `freezes.ts`), migration `0006` | `tests/accounting.test.ts` |
| Atomic multi-asset reservations, UTC-day counters, expiry | `packages/accounting/src/reservations.ts` | `tests/accounting.test.ts` (concurrent overspend ×5 rounds) |
| Conserved allocation with expected budget version | `allocation.ts` | `tests/accounting.test.ts`, `tests/funds-api.test.ts` |
| Rate cards, model/hosting metering, unknown-charge handling, runway | `rates.ts`, `metering.ts`, migration `0007` | `rates.test.ts`, `tests/custody.test.ts`, `tests/funds-api.test.ts` |
| Deposits (pending → finalized credit), withdrawals ledger | `deposits.ts`, `withdrawals.ts` | `tests/custody.test.ts` |
| Full action policy (live context blocks, combination rules) | `packages/policy` (`action-policy/2`) | `live-policy.test.ts` |
| Privy client, local chain/provider, JSON-RPC reader, deposit scanner, withdrawal gateway | `packages/custody` | `privy.test.ts`, `tests/custody.test.ts` |
| User API, step-up, hosting pause | `apps/api/src/funds.ts`, `app.ts`, `runtime-control/store.ts#meterHosting` | `tests/funds-api.test.ts` |
| Operate → Live funds panel | `apps/web/src/FundsPanel.tsx` | Chrome check on `pnpm stack:dev` (local chain) |

## 2. Run it locally

`pnpm stack:dev` starts the API with `CUSTODY_PROVIDER=local`: an in-process chain (finality depth 2) and
deterministic wallets, labelled local everywhere. In Operate → Live funds: open the wallet, use "Add local …"
(mints test assets and finalizes them), allocate (raising trading asks for a code; the code is printed in the
`[api]` log), verify a destination and withdraw. Nothing touches a real network or key.

The local chain lives in the API process, produces one block per worker tick (2 s) and starts empty on every run
with a fresh chain ID (`LOCAL_CHAIN_ID` pins one). Ledger balances persist in the database, so an agent funded in
an earlier run will show a reconciliation freeze against the new, empty chain; use a new agent for each local run.
Reconciliation runs only once the deposit scanner has processed the finalized head; while it lags it defers.

## 3. User API

All routes need the session cookie. Money commands take `Idempotency-Key`. Bodies are closed `funds-1` contracts.

| Route | Body / result |
| --- | --- |
| `POST /v1/agents/{id}/wallet` | Provision (idempotent) → address, chain, accepted assets. `503 CAPABILITY_DISABLED` without custody. |
| `GET /v1/agents/{id}/balances` | `agent-funds/1`: buckets (balance, held, available), pending/quarantined deposits, freeze state. |
| `POST /v1/agents/{id}/allocations` | `AllocationRequest` (target totals; `stepUpId` when trading rises) → new `budgetVersion`. |
| `POST /v1/agents/{id}/funding-quotes` | `FundingQuoteRequest` → stored `funding-quote/1` (5-minute expiry; advisory). |
| `POST /v1/step-up/challenges`, `…/{id}/verify` | Bind a one-time code to exact terms (D45). |
| `POST /v1/agents/{id}/withdrawal-destinations` | Verified owner address (step-up). Replaces the chain's previous address. |
| `POST /v1/agents/{id}/withdrawals` → `GET /v1/withdrawals/{id}` | `withdrawal/1`. Works while paused or stopped; no strategy or runtime path reaches it. |

Errors: `INSUFFICIENT_BUDGET`, `POLICY_DENIED` (daily limit), `RECONCILIATION_REQUIRED` (freeze),
`REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `FORBIDDEN` (step-up), `CAPABILITY_DISABLED` (no custody or price).

## 4. Privy proof (E03)

Needed from the project owner (create these yourself; never paste secrets in chat or commit them):

1. A Privy account and app (dashboard.privy.io). Copy the app ID and app secret into your local `.env` as
   `PRIVY_APP_ID` / `PRIVY_APP_SECRET`.
2. An authorization key: `node scripts/custody-proof.ts --new-key` prints `PRIVY_AUTHORIZATION_KEY=…` once; put it
   in `.env`. Its public half becomes the owner of every wallet and policy we create.
3. Run `pnpm custody:proof`. It creates one test wallet and checks idempotent creation, ownership by our key,
   that the app secret alone cannot sign, that the owner signature can, policy denial of an unapproved
   destination, export denial without the owner signature and recovery from a fresh client. No funds move.
4. Record the printed dated result under E03 in `docs/decisions.md`. Only then consider `LIVE_OUTFLOWS=1`.

## 5. Chain and asset (E04/E06)

Set `CUSTODY_PROVIDER=privy`, `CUSTODY_CHAIN_ID`, `CUSTODY_NETWORK_REF`, `CUSTODY_RPC` (and
`CUSTODY_RPC_SECONDARY` for cross-checked finality), and the verified funding token
(`FUNDING_TOKEN_ADDRESS`, `FUNDING_TOKEN_DECIMALS`, `FUNDING_ASSET_REF`). Verify the address and decimals from the
issuer's official source and a block explorer; do not copy them from a chat or a search snippet. Fund the agent
wallet with testnet MON for gas and the test token, then watch `GET /balances` move from pending to credited.

## 6. Rate cards

Prices live in immutable `rate_cards` rows (`publishRateCard`), in the funding token's atomic units, with a
`source`. None are seeded: publish real hosting (per 60 s slice) and model prices (per million tokens, E05) with
their provenance, or clearly labelled placeholders for demos. A profile without a card is not billed and cannot
be quoted.

## 7. For the next consumers

- **Live executor (#37):** build `ActionContext` with every live block (`identity`, `chain`, `quote`, `gas`,
  `allowance`, `notional`, `branchEvidenceVerified`, `signerReady`, `reconciliationOpen`); a missing block denies.
  Reserve token-in plus MON gas with `reserve(…, purpose: 'trade', window: …)` in the admission transaction,
  `markDispatched` before signing, `markReconciling` on an ambiguous send, `settle` with `swapPostings` from the
  finalized receipt. Send through `CustodyProvider.send` with the intent's logical key as idempotency key.
- **AI broker (#8/#9):** `reserveModelCall` before dispatch, `recordModelDispatch` before sending,
  `settleModelUsage` with reported usage, `markModelUnknown` on timeout. The worker escalates after 24 h and the
  profile pauses until `resolveUnknownUsage`.
- **Withdrawal gateway placement:** it runs in the API funds worker today. If #37 moves it into the executor, keep
  it out of `apps/executor/src/service.ts`/`server.ts` (the intent path), which `tests/funds-api.test.ts` checks
  never mention withdrawals. Native withdrawals refresh the wallet's provider policy with the verified destinations
  before sending.
- **Costs UI (#45):** `agent-funds/1`, `funding-quote/1` and `usage_records` per slice or call.
