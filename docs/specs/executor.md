# Executor specification

Version: `executor/1` design baseline. Owner: `apps/executor`, with accounting, policy, connector and API/data-owner review. Status: normative design; no executor behavior is implemented merely because this document exists.

This document is the authoritative specification for the hosted executor process: its HTTP boundary, intent identity, state machine, admission order, paper/live adapters, signing recovery and settlement responsibilities. The platform [runtime specification](runtime.md) remains authoritative for deployment generations, jobs, checkpoints and runtime isolation, while [agent runtime](agent-runtime.md) defines the process that submits intents; [funds and budgets](funds-and-budgets.md) governs journals, balances and reservations; [connectors](connectors.md) governs quotes, transaction construction and receipt interpretation; [security](security.md) governs platform-wide authorization and incident controls; and [API/data](api-and-data.md) governs shared wire and storage conventions. Resolve conflicts before implementation rather than selecting the least restrictive rule.

## 1. Purpose and scope

The executor turns an untrusted, typed action proposal into either a deterministic rejection, a paper effect, or a narrowly authorized live transaction. It is the only application process allowed to use ordinary wallet-signing credentials. A strategy, runtime, model, browser or connector can propose an action; none can authorize money movement.

The initial supported action is one reviewed `swap.exactInput` capability on one verified Monad network and token pair. Paper mode implements the same intent and policy boundary with a distinct simulation identity. Withdrawals, deposits, treasury sweeps and allowance cleanup eventually use the same transaction-attempt and reconciliation machinery, but they are not strategy actions and are outside the first executor slice.

The hosted executor is an authenticated internal HTTP service. It is not a general wallet RPC proxy, arbitrary contract-call service, remote tool registry or user-visible signing API.

### Goals

- Accept only closed, versioned action intents from capability-authenticated runtimes.
- Derive ownership, wallet, mode, deployment and generation from trusted server state.
- Match every intent to one reachable action node in the approved immutable strategy.
- Apply deterministic policy using current authority and fresh market/accounting context.
- Reserve token input, gas and spend-window capacity atomically before external effects.
- Build, decode and simulate only reviewed connector transactions.
- Give every logical effect, provider request, nonce and transaction attempt durable identity.
- Recover after timeouts or crashes without creating a new logical trade.
- Settle paper and live outcomes once and expose truthful status and safe evidence.

### Non-goals for `executor/1`

- Arbitrary calldata, recipient, chain, RPC URL, spender, permit or nonce supplied by a runtime.
- Arbitrary message or typed-data signing, key export, bridge, leverage, lending or multihop routing.
- Public deposits or production custody merely because the capped team-fund demo succeeds.
- More than one unresolved live nonce per wallet.
- More than one trade intent per run unless a later reviewed strategy version permits it.
- Automatic replacement trades after uncertain signing, broadcast or settlement.

## 2. Trust boundary and process authority

| Actor | May do | Must never do |
| --- | --- | --- |
| Runtime | Submit a typed intent and poll its status using a short-lived scoped capability | Choose wallet, recipient, chain, target, spender, nonce, calldata or signing method |
| Control API | Create deployments, pause/revoke authority, expose user history | Hold ordinary wallet-signing credentials or submit raw transactions on behalf of the runtime |
| Executor | Authorize, reserve, quote, build, simulate, sign, broadcast, reconcile and settle approved effects | Expand a strategy, ignore current revocation, expose keys or offer a generic signing route |
| Policy package | Return a pure verdict and stable reasons for supplied immutable context | Mutate balances, reserve funds or sign |
| Accounting package | Reserve and settle exact per-asset amounts under database transactions | Contact chain, quote or wallet providers inside a transaction |
| Connector package | Quote, build/decode reviewed calls and interpret receipts | Own a key, authorize a user or bypass policy/accounting |
| Wallet provider | Protect key material and apply configured defense-in-depth rules | Replace application reservations, policy, nonce recovery or reconciliation |

The executor has a restricted database role for executor-owned financial records and the minimum deployment/run evidence needed to authorize an intent. It does not accept browser sessions. Runtime authentication uses workload identity plus a short-lived capability whose audience is the executor and whose tenant, agent, deployment, generation, mode, run and allowed actions are fixed.

Signing credentials, provider-policy administration credentials and operator recovery credentials are separate. Normal executor operation cannot weaken its own provider policy.

## 3. HTTP interface

All routes are internal HTTPS JSON under `/internal/v1`. Requests and responses are validated against closed JSON Schemas before use. The service rejects unknown versions and fields.

### `POST /internal/v1/intents`

Accept a proposed action or return the previously recorded result for the same logical intent.

Required headers:

- Workload authentication established by the selected internal identity mechanism.
- `Authorization: Bearer <runtime-capability>` with audience `executor`.
- `Idempotency-Key`, equal to the body `logicalKey` for `executor/1`.
- `X-Request-ID`, a server-compatible request identifier for tracing; it is not financial identity.

Responses:

| Status | Meaning |
| --- | --- |
| `200` | Duplicate known intent; current frozen representation/status returned |
| `201` | New intent durably admitted, including a terminal policy rejection |
| `202` | Known intent remains pending/reconciling; poll `GET /internal/v1/intents/{intentId}` |
| `400` | Malformed JSON or headers |
| `401` / `403` | Invalid workload identity/capability or capability outside its scope |
| `409` | Same logical/idempotency key with different canonical body, stale generation or conflicting identity |
| `422` | Well-formed intent cannot match the approved strategy or supported capability |
| `429` | Admission quota reached before any financial dispatch |
| `503` | Required trusted dependency unavailable before safe admission; no new external financial effect created |

A policy denial is a successful, durable processing result, not an infrastructure `500`. The response carries `state: "rejected"` and a stable reason code.

### `GET /internal/v1/intents/{intentId}`

Return status only when the caller capability is for the same tenant, agent, deployment generation and run. The response never includes signed bytes, provider credentials, raw private policy configuration or internal recovery tokens.

The executor may additionally use private operator/reconciler entry points, but they are bound to distinct workload identities and are not callable with runtime capabilities. No route accepts raw bytes to sign.

## 4. Action intent contract

`ActionIntent` is a proposal, not authorization. Implemented 2026-10-07 as [`action-intent-1`](../../packages/contracts/schemas/action-intent-1.schema.json) with [`intent-result-1`](../../packages/contracts/schemas/intent-result-1.schema.json) and the `intentKey()` helper in `packages/contracts`; the example below is its `spec-swap-fixed` fixture. Integration steps: [executor integration guide](../integration/executor.md).

Illustrative `swap.exactInput` request:

```json
{
  "schemaVersion": "action-intent/1",
  "logicalKey": "0x4b7fbfb8f69f3c6f54df9db29a6402e2cff87ffed9dd94f62da27c34568c7bc4",
  "runId": "0xb956dcf10050a6ff918cfabf6f09c0a4c21995f3295e4f186101718e5b810e08",
  "nodeId": "buy_weth",
  "iterationPath": [],
  "connectorRef": "monad.uniswap",
  "connectorVersion": "1.0.0",
  "action": "swap.exactInput",
  "tokenInRef": "monad.USDC",
  "tokenOutRef": "monad.WETH",
  "amount": {
    "kind": "fixed",
    "atomic": "5000000"
  },
  "maxSlippageBps": 50,
  "observationRefs": [
    "019a0000-0000-7000-8000-000000000111"
  ]
}
```

Rules:

- `runId` uses the strategy engine's 32-byte hash identity until a future contract explicitly replaces it.
- `nodeId` and `iterationPath` identify exactly one effect-producing execution of an approved AST node.
- `connectorRef` and exact version must appear in the deployment manifest and capability.
- Asset refs resolve through that pinned connector/network catalog; symbols alone are invalid.
- `amount` uses the existing strategy amount union. The executor resolves `positionBps` against fresh available trading inventory and freezes the resulting atomic input before reservation.
- `maxSlippageBps` can only narrow the approved strategy/platform/user/connector limits. It cannot widen them.
- `observationRefs` identify persisted broker results needed to prove branch choice, freshness and valuation. Embedded observations are not accepted.

The schema does not contain tenant ID, agent ID, deployment ID, generation, mode, wallet reference, chain ID, target address, spender, recipient, nonce, gas values, deadline, quote, calldata, RPC URL, provider request, signature or private key. Adding one of these fields is a contract/security review, not a compatible optional field.

### Logical identity

One financial action node produces at most one logical intent for a given deployment generation, run and iteration path. The canonical executor key is:

```text
SHA-256(JCS({
  schemaVersion: "intent-key/1",
  deploymentId,
  generation,
  runId,
  nodeId,
  iterationPath
}))
```

`deploymentId` and `generation` come from the authenticated capability/current deployment, not the body. The runtime computes the same value from its manifest and sends it as `logicalKey`; the executor recomputes and rejects a mismatch. The key does not include quote, nonce or provider data because refreshing those under the same still-valid authorization must not create another trade.

If a future language version permits a node to emit more than one action in one iteration, that version must add an explicit bounded effect ordinal to the key contract.

### Intent representation returned to callers

The safe response includes:

- `schemaVersion: "intent-result/1"`
- Executor-generated `intentId`.
- `logicalKey`.
- Current state and timestamps.
- Frozen action summary: asset refs, resolved input amount when known, maximum slippage and connector version.
- Stable rejection/failure reason and safe message where applicable.
- Paper fill ID or public transaction hash/explorer reference only after they exist.
- Final actual input/output/gas amounts only after trusted interpretation/settlement.
- No status URL field: callers poll `GET /internal/v1/intents/{intentId}` while the state is non-terminal (contract field names exclude `url`).

It excludes signed bytes, raw provider responses, secret refs and unrestricted calldata. User-facing API responses are derived from audit/intent records rather than forwarding this internal response blindly.

## 5. Admission and authorization sequence

The executor performs these checks in order. Steps described as atomic run in one short database transaction; external provider calls never occur inside it.

1. Enforce body-size/content-type limits and parse the versioned schema.
2. Authenticate workload identity and executor-audience runtime capability.
3. Derive tenant, agent, deployment, generation, mode, run and allowed actions from the capability.
4. Recompute the logical key and idempotency request hash.
5. Resolve an existing logical key. Same canonical body returns its current result; different body is an idempotency conflict.
6. Load current deployment authority and deny stale generation, paused/stopping/stopped deployment, expired capability or wrong run.
7. Load the immutable strategy revision/manifest and resolve `nodeId` as the declared financial action.
8. Validate the iteration path against bounded repeat structure and verify the active branch from persisted predecessor results using the shared pure evaluator. The executor replays from immutable run identity and pinned artifacts, never runtime checkpoint bindings. Referenced broker results must belong to this tenant/deployment/generation/run, match the authored request and be complete and fresh. Missing or contradictory evidence denies before reservation.
9. Confirm action, connector/version, assets, amount rule and slippage do not widen the AST or manifest.
10. Load fresh wallet/simulation identity, balances, policy, budget, connector readiness, spend-window state and referenced observations.
11. Evaluate pure policy. Missing or stale required context denies.
12. Atomically create the frozen intent, policy verdict, input/gas/counter reservations and outbox/audit records. For a rejection, create the terminal intent and policy audit without financial reservations.
13. Commit before any quote, signer or RPC call.
14. Dispatch the admitted intent through the paper or live adapter according to the authoritative deployment mode.

The final pre-sign step repeats all revocable checks that may have changed since admission: deployment desired state, current generation, connector/action kill switches, policy version/limits, reservation validity, quote/reference freshness, gas ceiling and provider readiness.

## 6. Policy contract and denial reasons

`packages/policy` owns a pure `evaluateAction(context): verdict` interface. The executor assembles the complete immutable context and enforces the result. Policy does not query providers or mutate the database.

Minimum context:

- Tenant, agent, deployment, generation, mode, run and wallet/simulation identity.
- Approved AST action and actual iteration/branch evidence.
- Connector/version/capability and network/chain.
- Token identities, resolved input ceiling, recipient and spender derived from trusted registries.
- Platform, user, strategy and connector limits, combined by the most restrictive value.
- Available trading balance, native reserve, active reservations and spend counters.
- Reference valuation, source, observed time and freshness.
- Quote output, expiry, price impact, slippage/minimum output and route summary where available.
- Gas/fee ceiling, allowance requirement and decoded transaction effects where available.
- Deployment/pause/kill-switch and wallet-provider readiness.

The executor evaluates policy at admission, after quote/build/simulation, and immediately before signing. Later phases add context; they never discard an earlier denial.

Initial stable reason codes:

| Code | Meaning |
| --- | --- |
| `EXECUTOR_CAPABILITY_INVALID` | Workload/capability is absent, expired, wrong-audience or out of scope |
| `EXECUTOR_STALE_GENERATION` | Deployment generation is no longer authorized |
| `EXECUTOR_DEPLOYMENT_INACTIVE` | Deployment is not allowed to create a new financial effect |
| `EXECUTOR_INTENT_CONFLICT` | Same logical key was presented with different frozen parameters |
| `EXECUTOR_AST_MISMATCH` | Node/action/iteration/branch does not match approved strategy evidence |
| `EXECUTOR_CONNECTOR_DISABLED` | Connector/version/action is absent, unready or killed |
| `EXECUTOR_ASSET_NOT_ALLOWED` | Chain, input/output asset, pair, recipient or spender is not approved |
| `EXECUTOR_AMOUNT_EXCEEDED` | Resolved input exceeds strategy/user/platform or available-balance limit |
| `EXECUTOR_DAILY_LIMIT_EXCEEDED` | Pending plus committed action/notional window would exceed its limit |
| `EXECUTOR_NATIVE_RESERVE_LOW` | Required native gas reserve would be violated |
| `EXECUTOR_STALE_OBSERVATION` | Required observation/reference valuation is missing or too old |
| `EXECUTOR_QUOTE_INVALID` | Quote is stale, inconsistent, too impactful or outside the intent |
| `EXECUTOR_SLIPPAGE_EXCEEDED` | Requested or computed slippage/minimum output violates a limit |
| `EXECUTOR_GAS_LIMIT_EXCEEDED` | Required fee/gas hold exceeds approved ceiling |
| `EXECUTOR_ALLOWANCE_UNSAFE` | Spender, amount, permit or approval behavior is unsupported |
| `EXECUTOR_SIMULATION_FAILED` | Exact prepared transaction failed or produced unexpected effects |
| `EXECUTOR_INSUFFICIENT_BUDGET` | Atomic input/gas/counter reservation cannot be created |
| `EXECUTOR_RECONCILIATION_REQUIRED` | Existing unknown effect or balance discrepancy blocks new execution |
| `EXECUTOR_PROVIDER_UNAVAILABLE` | Required provider is unavailable before a safe external dispatch |

Externally exposed API errors may map these to the shared vocabulary while preserving the executor reason inside a bounded safe detail/audit field.

## 7. State machines

### Intent state

```text
proposed -> rejected
proposed -> reserved -> prepared -> signing -> signed -> submitted
submitted -> included -> finalized -> settled

reserved/prepared -> cancelled
signing/signed/submitted/included/finalized -> reconciling
reserved/prepared/signing/submitted/included/finalized -> failed only with proven effect outcome
reconciling -> signed | submitted | included | finalized | settled | failed
```

Rules:

- `rejected`, `settled`, `failed` and pre-dispatch `cancelled` are terminal for the logical intent.
- `failed` means absence/revert is established and any real cost is accounted for; a timeout is not failure.
- `cancelled` is allowed only before an externally usable authorization exists and after safe release checks.
- `included` is provisional and cannot settle balances.
- `finalized` means canonical finality and decoded effects are established; settlement may still be retried idempotently.
- State transitions use conditional updates from allowed prior states. Duplicate transition requests return the stored result.
- Every transition writes an audit event in the same transaction as its authoritative state change.

### Reservation state

```text
held -> dispatched -> settled
held -> released
dispatched -> reconciling -> settled | released-with-proof
```

Once signing or another external effect may have occurred, associated reservations cannot expire automatically. Quote expiry does not release a dispatched hold.

### Transaction attempts

An intent may own an approval child transaction and a swap transaction. Fee-bump or same-nonce recovery attempts remain children of the same logical transaction owner. They are not new strategy intents and cannot increase the authorized token input or recipient set.

## 8. Paper execution

Paper mode proves the complete runtime-to-executor contract without loading wallet or signing credentials.

1. Require a paper deployment and simulation account; reject live wallet references.
2. Perform the common admission, AST, policy and reservation path.
3. Obtain an already recorded quote/market observation with explicit provenance and freshness.
4. Resolve fixed or position-basis-point input from the virtual available balance.
5. Apply documented fee, liquidity, latency and adverse-slippage assumptions using exact arithmetic.
6. Reject rather than fabricate a fill when required market data or virtual balance is missing.
7. Create a deterministic synthetic fill ID from the logical intent and paper-adapter version.
8. Atomically settle virtual balances/reservations and append audit/timeline records.
9. Return `mode: paper` and the synthetic fill ID; never return a plausible transaction hash or explorer URL.

Replaying or redelivering an intent returns the same fill and does not alter virtual balances twice. Resetting a paper portfolio creates a new simulation session and history. Paper balances, fills and reservations can never become live wallet records.

Minimum G4 paper scenarios:

- Successful exact-input fill.
- Insufficient virtual input.
- Stale/missing quote.
- Policy denial.
- Duplicate intent delivery.
- Runtime crash after intent admission and before observing settlement.
- Executor crash before and after virtual settlement commit.
- Pause between admission and dispatch.

## 9. Live exact-input execution

Live mode remains disabled until external gates E03, E04 and E06 in [decisions](../decisions.md) have dated evidence. The first route is one exact-input spot pair with team-controlled funds.

### Preparation

1. Serialize execution for the wallet/chain; `executor/1` allows one unresolved nonce.
2. Re-read canonical wallet balance, native balance/reserve and allowance.
3. Resolve the atomic input without exceeding the reservation ceiling.
4. Obtain a fresh independent reference price and connector quote.
5. Compute `minimumOutput` by exact floor arithmetic from expected output and the most restrictive slippage limit.
6. Freeze quote identity, source state, expiry, route, recipient, expected/minimum output and fee assumptions.
7. Ask the connector to build the reviewed transaction from the frozen intent/quote.
8. Decode the complete result and compare chain, target, selector/commands, spender, assets, recipient, input, minimum output, deadline and value with the frozen authorization.
9. Reject unknown nested commands, multicalls, dynamic recipients, fee-on-transfer/rebasing assets, infinite allowances and unsupported permit forms.
10. Estimate gas and confirm the reservation/fee ceiling still covers approval plus swap.

### Allowance

Prefer no approval where the reviewed route/provider supports a safer bounded method. Otherwise create a child approval transaction for the exact reviewed spender and bounded required amount. Its nonce, gas reservation, signing identity, receipt and actual gas are durable records. Wait for canonical finality before obtaining a fresh swap quote. An approval success is not a swap success. Allowance cleanup is an explicit later operation and stopping a runtime does not revoke an allowance.

### Simulation and signing

1. Simulate the exact prepared transaction at the freshest supported state.
2. Decode/validate simulation effects, not only its success flag.
3. Recheck current deployment authority, kill switches, policy, quote/reference freshness, balance/reservations and gas ceiling.
4. Allocate a durable nonce slot unique on `(wallet, chain, nonce)` and owned by the logical transaction.
5. Persist a signing attempt with a unique provider request key before calling the wallet provider.
6. Prefer `signTransaction` with recoverable signed bytes/hash followed by application-controlled broadcast when the verified provider supports it.
7. If only provider-managed send is used, require proven request lookup, idempotency and nonce recovery before enabling live mode.
8. Persist signed hash/bytes identity before broadcast where the provider workflow permits. Signed bytes are encrypted privileged artifacts, never normal logs or runtime responses.

### Broadcast, finality and settlement

1. Broadcast once under a durable dispatch record.
2. On ambiguous response, reconcile the same provider key/hash/nonce. Rebroadcast only identical signed bytes while valid; never create a fresh trade.
3. Record inclusion as provisional.
4. Require successful/reverted receipt at a height no greater than the observed finalized height and a matching canonical block hash.
5. On contradictory provider/RPC answers, query the configured second source, set `reconciling` and block new wallet execution until resolved.
6. Decode actual token movements and gas from the canonical receipt and compare them with the prepared transaction.
7. Atomically post per-asset journals, settle/release reservations and spend-window holds, and mark the intent settled once.
8. Successful swap: settle actual input/output and gas. Reverted swap: release token input, charge actual approval/swap gas and preserve history. Unexpected effects: freeze new live outflows and require reconciliation.

## 10. Connector boundary

The executor consumes a pinned connector implementation through a narrow local package interface. Connector network responses remain untrusted until validated by the executor.

```ts
interface ExecutionConnector {
  quote(input: QuoteInput): Promise<QuoteResult>;
  buildExactInput(input: BuildExactInput): Promise<UnsignedTransaction>;
  decode(transaction: UnsignedTransaction): DecodedEffects;
  interpretReceipt(input: ReceiptInput): Promise<ReceiptEffects>;
}
```

The concrete types must be generated/shared contracts or private executor-owned types with runtime validation at provider boundaries. `UnsignedTransaction` is never accepted from the runtime. `DecodedEffects` must be rich enough to verify every supported nested command; inability to decode means rejection.

The connector does not decide authorization, reserve funds, sign, broadcast or settle. A connector version/address/ABI change publishes a new immutable catalog version and requires conformance evidence.

## 11. Wallet-provider boundary

The wallet adapter exposes only operations proven for the chosen provider workflow:

```ts
interface WalletSigner {
  getWallet(ref: string): Promise<VerifiedWallet>;
  signTransaction(request: SignRequest): Promise<SignResult>;
  lookupRequest(providerRequestId: string): Promise<ProviderRequestState>;
}
```

If application-controlled signing is unavailable, a separately reviewed `sendTransaction` method may replace `signTransaction` only after its idempotency, request lookup, nonce and recovery semantics pass E03. The adapter has no `signMessage`, `signTypedData`, key export, arbitrary policy update or arbitrary-chain method.

Provider receiver/chain/value rules are defense in depth. Application policy and accounting reservations remain authoritative. The executor startup/readiness check fails live readiness when provider policy, signing or recovery capability cannot be proven.

## 12. Persistence model

The implementation adds forward-only migrations for the relations below. Exact column names are finalized with the API/data owner; the invariants are required.

| Relation | Required invariants |
| --- | --- |
| `intents` | Tenant/agent/deployment/generation/run; unique logical key; canonical request hash; frozen action; policy/quote refs; state/version; terminal result |
| `policy_verdicts` | Intent + evaluation phase; policy versions/context hash; allow/deny; stable reasons; immutable |
| `simulation_accounts` / `paper_fills` | Mode/session separation; unique logical fill; exact virtual asset changes; no chain hash |
| `reservations` / `spend_windows` | Unique operation/asset holds; pending included in caps; state and settlement journal |
| `wallets` | Tenant/agent/network/provider ID/address; state; no secret material |
| `nonce_slots` | Unique wallet/chain/nonce; one logical transaction owner; unresolved status |
| `transaction_attempts` | Parent intent/action; kind; nonce slot; provider request and tx hash uniqueness; state; encrypted artifact ref where allowed |
| `ledger_accounts`, `journals`, `postings` | Immutable, idempotent and balanced within each asset |
| `audit_events` / `outbox` | State change and publication committed together; safe redacted payload |

Atomic boundaries:

- Intent + initial verdict + reservations/counter holds + audit/outbox.
- Prepared quote/build metadata + state transition, without holding a transaction during provider calls.
- Nonce slot + signing-attempt identity.
- Transaction state transition + audit/outbox.
- Final settlement journal + reservation/counter settlement + intent result + audit/outbox.

Use deterministic lock ordering for wallet/account/counter rows. Optimistic row versions or expected-state updates prevent two workers advancing the same effect concurrently. Executor work may be delivered at least once; every handler is idempotent by logical identity and expected state.

## 13. Retry and recovery

| Failure point | Required behavior |
| --- | --- |
| Before intent transaction commits | Caller may retry same body/key; no intent or hold exists |
| After intent commit, before response | Retry resolves existing intent and never reserves twice |
| Quote/read timeout | Retry within freshness deadline at most the configured bounded count; no signing occurred |
| Crash after preparation | Resume same intent; refresh expired quote under unchanged input ceiling |
| Crash before signer call | Signing attempt record shows undispatched; revalidate before dispatch |
| Timeout during/after signer call | Set/recover `reconciling`; query same provider request/nonce; do not call with a new logical key |
| Signed but broadcast unknown | Recover hash/bytes/provider request and reconcile; only identical-byte rebroadcast when valid |
| Included but not final | Continue finality/canonicality polling; do not settle or free holds |
| Settlement DB retry | Reapply same unique journal/settlement key; exactly one economic posting |
| Provider/RPC disagreement | Freeze wallet execution and reconcile through configured evidence sources |
| Executor restart | Scan non-terminal intents/attempts by state and resume state-specific reconciliation |

Retries use bounded backoff and never outlive quote, capability or policy validity where a fresh authorization is required. A revoked deployment blocks new signing but does not prevent reconciliation of already dispatched effects.

## 14. Pause, stop and kill switches

Pause authority is checked from current control state, not only the capability expiry. Once pause is accepted:

- Reject new intents and new financial reservations.
- Cancel/release admitted work only when no usable signature/external dispatch exists.
- Do not initiate signing for prepared work.
- Continue reconciling signed/submitted/included effects.
- Keep audit/history/status available.

Kill switches operate independently for all live signing, tenant, agent, wallet, connector, action, route or provider. Disabling signing never deletes records or fabricates cancellation. Withdrawal/recovery availability follows the incident procedure and uses a separate authenticated user flow.

## 15. Observability and data handling

Structured logs and metrics include trace, intent, run, deployment, generation, connector and transaction-attempt IDs; state transition; latency; retry count; denial reason; reservation age; pending nonce age; quote/reference age; finality lag and reconciliation mismatch. They exclude bearer capabilities, provider credentials, signed bytes, raw private prompts and full provider payloads.

Every significant transition emits the existing audit types where applicable: `policy.denied`, `reservation.changed`, `transaction.stateChanged` and `ledger.settled`. Add a new audit type only through the versioned audit contract; do not overload free-form log text as product history.

Minimum alerts:

- Unknown signed/provider effect.
- Nonce or intent stuck beyond threshold.
- Reservation stuck in dispatched/reconciling.
- Canonical/RPC disagreement.
- Ledger/on-chain balance mismatch.
- Unexpected decoded effect or unsupported token behavior.
- Provider policy/readiness failure.
- Repeated policy-denial or signing-error spike.

## 16. Configuration and readiness

Server-owned configuration pins:

- Enabled modes and global live kill switch.
- Network/chain and two finality evidence sources for live settlement.
- Connector/version, addresses/ABIs and approved pair.
- Quote/reference freshness and deviation limits.
- Slippage, price-impact, input, daily count/notional and gas ceilings.
- Wallet-provider workspace, signing method and secret references.
- Reconciliation intervals/backoff and encrypted artifact storage.
- Paper adapter assumptions/version.

The readiness endpoint reports paper and live readiness separately with safe reason codes. Paper can remain ready while live is disabled. Live readiness requires all relevant external gates, DB migrations, provider policy, wallet mapping, connector route, reference data, signer recovery and finality sources to be proven.

## 17. Suggested implementation layout

Start cohesive; split only where the interface is real:

```text
apps/executor/src/
  server.ts             HTTP/auth/schema boundary
  service.ts            intent orchestration and state transitions
  authorization.ts      AST/evidence/current-authority resolution
  paper.ts              paper adapter
  live.ts               live preparation/signing orchestration
  reconciliation.ts     non-terminal recovery workers
  store.ts              executor SQL transactions
  wallet.ts             narrow provider adapter
  readiness.ts          paper/live capability status

packages/policy/src/
  action-policy.ts

packages/accounting/src/
  ledger.ts
  reservations.ts
  spend-windows.ts

packages/connectors/src/
  manifest.ts
  uniswap-exact-input.ts
```

This layout is a starting point, not permission to create empty abstraction folders or competing data models. Shared wire schemas land in `packages/contracts` before runtime and executor consumers.

## 18. Implementation sequence

### Phase A — shared contract

1. Add ActionIntent and IntentResult schemas, fixtures and generated types.
2. Add policy verdict/reason vocabulary or a versioned bounded representation.
3. Add one request/duplicate/conflict contract test shared with runtime.

### Phase B — G4 paper executor

1. Add intent/simulation/reservation/audit migrations needed for paper mode.
2. Implement capability/current-generation checks and AST/evidence matching.
3. Implement pure minimal policy and atomic virtual reservations.
4. Implement paper fill/settlement and intent status endpoint.
5. Prove duplicate delivery and crash/replay safety with a real PostgreSQL test.

Status 2026-10-08: steps 1–5 implemented for paper in [`apps/executor`](../../apps/executor/src/) on migration `0004_executor_paper.sql`, with deployment authority and recorded market data behind ports until the control API provides them (its `deployments` table exists since `0003_runtime_control.sql` but is not yet sufficient); see the [integration guide](../integration/executor.md#3a-capability-and-deployment-authority) and decisions D35–D36.

### Phase C — G5 financial foundation

1. Add per-asset balanced ledger and multi-asset reservations.
2. Add spend-window holds, wallet mapping and reconciliation freeze.
3. Prove concurrent overspend, duplicate settlement and deficit behavior.
4. Complete wallet-provider capability/policy/recovery probe without enabling live by default.

### Phase D — G8 capped live route

1. Publish verified connector/network/asset/route catalog evidence.
2. Implement quote/build/full decode/receipt interpretation and conformance checks.
3. Implement nonce/signing-attempt/broadcast/finality recovery.
4. Execute one permitted team-fund swap and one policy-denied attempt.
5. Inject crash/timeout after signing/broadcast and prove no duplicate logical trade.

## 19. Required verification

Before G4 paper exit:

- Same body/key returns one intent/fill; changed body with same key conflicts.
- Wrong tenant/run/generation/mode/action capability is rejected.
- Wrong AST node, branch or iteration is rejected.
- Two concurrent submissions reserve/fill once.
- Paper adapter cannot resolve a wallet or emit a transaction hash.
- Crash/restart around admission and settlement produces one economic result.
- Pause prevents new effects while existing status remains queryable.

Before G5 exit:

- Two simultaneous intents/withdrawal cannot overspend token or gas.
- Per-asset journals balance and duplicate settlement posts once.
- Pending reservations count against daily limits across UTC rollover.
- Balance discrepancy freezes live outflows.
- Signing credentials are unavailable to runtime/API worker and policy-admin credentials are unavailable to normal signer code.

Before G8 exit:

- Wrong chain/router/selector/spender/recipient/assets/minimum output/deadline fails before signing.
- Infinite/unknown approval, malformed nested command and unsupported route fail.
- Stale quote/reference, excessive deviation/slippage/gas and simulation failure create no signature.
- Provider timeout after signer call enters reconciliation under the same request/nonce.
- Crash after broadcast produces no second trade.
- Inclusion does not settle before canonical finality.
- Success/revert settles actual movements and gas exactly once.
- Explorer evidence, provider/connector versions, commit and mode are recorded for the team-fund demonstration.

These checks implement verification scenarios V07, V09–V11, V14 and V17–V22 in [verification](verification.md). Provider probes and team-fund transactions are explicit/manual checks and do not run in credential-free CI.

## 20. Unresolved external gates

The specification intentionally contains no guessed addresses, token decimals, pool liquidity, RPC finality behavior, wallet-provider policy claims or gas constants. Record dated evidence in [decisions](../decisions.md) before enabling live mode:

- E03: wallet ownership, policy/admin separation, signing method, export denial, idempotency and recovery.
- E04: token/native funding, exact router/pool/ABI/pair, decimals, liquidity and independent reference price.
- E06: second RPC, finalized/canonical behavior, backfill and quotas.

Failure of any gate keeps the executor paper-only. A functioning adapter or successful simulation is not permission to sign.

## 21. Definition of done

The executor is not done when an endpoint or provider SDK call exists.

- **G4 paper:** typed admission, current-authority/AST checks, policy denial, atomic virtual reservation/fill, durable status, duplicate/crash recovery and paper/live credential separation all pass.
- **G5 foundation:** provider capability proof, per-agent wallet mapping, balanced ledger, concurrent reservations/counters, native reserve and reconciliation freeze pass.
- **G8 live demo:** one reviewed route signs and settles a capped team-fund swap, one prohibited action is durably denied, and crash-after-send recovery proves one logical effect with canonical finality.

G8 evidence does not authorize public deposits, claim production custody readiness or complete G10.
