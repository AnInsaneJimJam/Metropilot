# Executor integration guide (for the executor owner)

This guide is for the owner of `apps/executor`. It covers only the runtime-facing contract: what the runtime sends, what it needs back and how a pending effect returns to the run. Admission, policy, reservations, signing and reconciliation are defined in the [executor specification](../specs/executor.md); wire shapes are [`action-intent-1`](../../packages/contracts/schemas/action-intent-1.schema.json) and [`intent-result-1`](../../packages/contracts/schemas/intent-result-1.schema.json).

Status 2026-10-07: the runtime builds and sends `ActionIntent`s and handles every result state. It runs against an in-memory paper executor, [`PaperExecutor`](../../apps/runtime/src/local/paper-executor.ts), which shows the expected behavior in about a hundred lines. Run `pnpm runtime:demo` to see admission, duplicates, crash recovery and settlement.

Status 2026-10-08: the real paper executor exists in [`apps/executor/src`](../../apps/executor/src/) (HTTP boundary, PostgreSQL store from migration `0004_executor_paper.sql`, pure policy in [`packages/policy`](../../packages/policy/src/action-policy.ts)). It passes the [conformance kit](../../apps/runtime/src/conformance/executor.ts) over HTTP against PostgreSQL in [`tests/executor-conformance.test.ts`](../../tests/executor-conformance.test.ts), through a test-only client that applies the §3 error mapping, and the G4 paper scenarios in [`tests/executor-paper.test.ts`](../../tests/executor-paper.test.ts). It has no process entry yet: deployment authority comes from the control API (section 3a).

**Not built yet: the runtime's HTTP clients and process entry point.** Until they exist, nothing calls your service; read [runtime HTTP clients](runtime-http-clients.md), especially the error mapping (§3: your `409` bodies need an `error-1` code the client can read) and the retry rules (§4: the runtime retries the identical intent after a timeout).

## 1. When the runtime calls you

The interpreter reaches a `swap.exactInput` node. Before calling you, the runtime has already saved the waiting checkpoint and the operation key with the control API. It then sends exactly one `POST /internal/v1/intents`. After a crash it sends the **same** intent again (same logical key, same canonical body); this is how recovery works, so a duplicate must return the recorded result, never a second effect.

## 2. The request

`POST /internal/v1/intents`, headers per [executor.md section 3](../specs/executor.md#3-http-interface), with `Idempotency-Key` equal to `logicalKey`. The body is a closed `action-intent/1` document ([normative example](../specs/executor.md#4-action-intent-contract), also a contract fixture):

| Field | Source in the runtime | What you do with it |
| --- | --- | --- |
| `logicalKey` | `intentKey()` from the assignment's deployment ID and generation plus the command | Recompute it from the **authenticated** capability (section 3); reject a mismatch |
| `runId`, `nodeId`, `iterationPath` | Interpreter command | Verify against the approved AST and recorded branch evidence |
| `connectorRef`, `connectorVersion` | Strategy node; version from the manifest pin in the assignment | Must match the deployment manifest and capability |
| `tokenInRef`, `tokenOutRef`, `amount`, `maxSlippageBps` | Strategy node, unchanged | `positionBps` resolves once against available inventory and is frozen |
| `observationRefs` | Broker result IDs recorded earlier in the run, in order | Load the persisted broker results; embedded observations are not accepted |

The body never contains tenant, agent, deployment, generation, mode, wallet, chain, recipient, spender, nonce, gas, deadline, quote, calldata or signature fields. Reject any unknown field with `400`.

## 3. The logical key

```text
logicalKey = "0x" + hex(SHA-256(JCS({
  schemaVersion: "intent-key/1", deploymentId, generation, runId, nodeId, iterationPath
})))
```

`deploymentId` and `generation` come from the capability and current deployment, never from the body. Use `intentKey()` from `@monad-hack/contracts`, or reproduce this vector (from [`keys.test.ts`](../../packages/contracts/src/keys.test.ts), checked independently with `sha256sum`):

```text
deploymentId  019a0000-0000-7000-8000-000000000202
generation    "3"
runId         0xb956dcf10050a6ff918cfabf6f09c0a4c21995f3295e4f186101718e5b810e08
nodeId        buy_weth
iterationPath []
JCS           {"deploymentId":"019a0000-0000-7000-8000-000000000202","generation":"3","iterationPath":[],"nodeId":"buy_weth","runId":"0xb956dcf10050a6ff918cfabf6f09c0a4c21995f3295e4f186101718e5b810e08","schemaVersion":"intent-key/1"}
logicalKey    0xb8f0dade82e733f451a1d1db26f95505adb0830b983a10a316dd8d423a39bc3c
```

Generation is a decimal **string**. Each repeat iteration is a distinct intent because `iterationPath` differs. The control API uses the same value as this operation's key, so one financial action has one key everywhere.

## 3a. Capability and deployment authority

Both inputs are provided by the control API since 2026-10-12 (branch `feat/lifecycle-executor-integration`). Executor unit and scenario tests still use the in-memory stand-ins in [`testing.ts`](../../apps/executor/src/testing.ts) for fault injection; [`tests/paper-stack.test.ts`](../../tests/paper-stack.test.ts) runs the real ones.

**Capability** ([D35](../decisions.md)): `Authorization: Bearer <token>`, a compact HS256 token signed with a secret shared only by the control API and the executor. Claims are closed and checked exactly as in [`packages/contracts/src/capability.ts`](../../packages/contracts/src/capability.ts) (moved there by [D38](../decisions.md); the executor's `capability.ts` re-exports it). The control API issues it through `POST /internal/v1/runtime/capabilities:exchange`:

```json
{
  "aud": "executor",
  "tenantId": "019a0000-0000-7000-8000-000000000000",
  "agentId": "019a0000-0000-7000-8000-000000000001",
  "deploymentId": "019a0000-0000-7000-8000-000000000202",
  "generation": "3",
  "mode": "paper",
  "actions": ["swap.exactInput"],
  "connectors": { "paper.uniswap": "1.0.0" },
  "runId": "0xb956dcf10050a6ff918cfabf6f09c0a4c21995f3295e4f186101718e5b810e08",
  "iat": 1791460800,
  "exp": 1791461100,
  "jti": "019a0000-0000-7000-8000-000000000999"
}
```

`runId` is optional; when present the capability is valid for that run only. `exp - iat` is at most 300 seconds. A live capability answers `403 CAPABILITY_DISABLED` while the executor is paper-only.

**Deployment authority:** the executor calls `AuthoritySource.current(tenantId, deploymentId)` ([`authorization.ts`](../../apps/executor/src/authorization.ts)) on every admission and again before each fill, so a pause takes effect before the capability expires. It returns the current generation, mode, desired state (`active`, `paused`, `stopping`, `stopped`), strategy revision ID, policy version, network ref, connector pins and, for paper, the simulation account ID. The approved AST, policy limits and catalog readiness are then read from `strategy_revisions`, `policies` and `catalog_versions`. Implement it over the `deployments` table; throwing means unavailable (`503`, nothing admitted).

Resolved 2026-10-12:

| Former gap | Resolution |
| --- | --- |
| Deployment state names differed | One vocabulary, `active` / `paused` / `stopping` / `stopped` ([D37](../decisions.md), migration [`0005`](../../apps/api/migrations/0005_deployment_lifecycle.sql)) |
| `deployments` lacked policy version, network ref and simulation account | Columns added in 0005; a paper launch fills them ([D39](../decisions.md)) |
| No `AuthoritySource` over `deployments` | [`PostgresAuthority`](../../apps/executor/src/authority.ts), read on every admission and fill |
| Nobody issued executor capabilities | The control API signs D35 tokens on exchange ([D38](../decisions.md)) |
| `intents` not foreign-keyed to `deployments` | Foreign key added in 0005; the test harness inserts a matching deployment row |
| Recorded market data was a stand-in | [`PostgresMarketData`](../../apps/executor/src/market.ts) over `market_observations`, written by ingestion |
| Pending results were not consumed | The control worker publishes `executor_outbox` and resumes runs ([D40](../decisions.md)) |
| No process entry or reconcile worker | [`main.ts`](../../apps/executor/src/main.ts) (`pnpm executor:dev`) with a 1 s `reconcile()` loop |

Still open: branch evidence for nodes under `if` stays unverified until broker results are persisted ([D36](../decisions.md); live must deny them), and hosted deployment must run `main.ts` under a restricted database role (grants: `select` on `deployments`, `strategy_revisions`, `policies`, `catalog_versions`, `market_observations`; read/write on the executor tables of migration 0004; nothing else).

The per-assignment bearer in `assignment-offer/2` (`capabilityGrant`) still authenticates the runtime to the control API only; the runtime exchanges it for this executor capability and never sends it to the executor.

## 4. Admission behavior the runtime relies on

| Situation | Answer |
| --- | --- |
| New, admissible intent | `201` with `intent-result/1` (often `reserved`, or already terminal in paper mode) |
| Same `logicalKey` and same canonical body | `200` with the current result for that intent; no new effect, no new reservation |
| Same `logicalKey`, different body | `409`, `error-1` code `IDEMPOTENCY_CONFLICT`, `details.reason = "EXECUTOR_INTENT_CONFLICT"` |
| `logicalKey` does not match the authenticated identity | `409`, code `IDEMPOTENCY_CONFLICT` |
| Stale or revoked generation | `409`, code `GENERATION_REVOKED`, `details.reason = "EXECUTOR_STALE_GENERATION"` for a new intent; a known intent's status stays readable |
| Paper capability for a live identity, or the reverse | `403` |
| Policy denial, insufficient balance | `201` with `state: "rejected"` and a stable `reason.code`; a denial is a durable result, not an error |
| Dependency unavailable before admission | `503`; nothing was dispatched |

Error bodies are `error-1`; the runtime reads only status and `code` ([mapping](runtime-http-clients.md#3-one-error-mapping-both-sides-implement-it)). Compare bodies with `canonicalize()` from `@monad-hack/contracts` (RFC 8785), not string equality of the raw request.

## 5. The result and how the runtime reads it

Answer with a closed `intent-result/1`. The runtime validates it and checks that `logicalKey` and `mode` match the request; anything else is treated as a failed boundary, never forwarded to the interpreter.

| `state` | Runtime outcome | Effect on the run |
| --- | --- | --- |
| `settled` | `settled` | Run continues to the next statement |
| `rejected`, `cancelled` | `rejected` | Run fails with `POLICY_DENIED`; no later statement runs |
| `failed` | `failed` | Run fails |
| `proposed` … `finalized`, `reconciling` | `pending` | Run waits; the runtime process is released |

Rules that matter to the runtime: `settlement` (actual input and output) only in `settled`; `reason` in `rejected` and `failed`; paper results carry `paperFillId` and never `transactionHash`; there is no status URL field, callers poll `GET /internal/v1/intents/{intentId}`.

## 6. Returning a pending intent to the run

The runtime does not poll you while an intent is pending. When your reconciliation reaches a definitive state (`settled`, `rejected`, `failed`), tell the control API, for example through an outbox row the API worker consumes, with the run ID, the logical key (which is the operation key) and the intent ID. The control API records the result and issues a resume assignment ([control API guide section 7](control-api.md#7-resuming-after-a-pending-operation)). The stand-in wires this as `onSettled → settleOperation`.

Implemented as the `executor_outbox` table (migration `0004`): every state change commits, in the same transaction, a `transaction.stateChanged` row with `run_id`, `logical_key`, `intent_id` and `payload.state` (plus `policy.denied`, `reservation.changed` and `ledger.settled` rows). The API worker resumes runs from definitive `transaction.stateChanged` rows, assigns the tenant audit sequence and sets `published_at`; only an unpublished row may be marked, and nothing else in a row can change. Consumed since 2026-10-12 by `RuntimeControlStore.consumeExecutorOutbox()` in the control worker loop: each row becomes an `audit-event/2` event (which types `runId` as the run hash, [D40](../decisions.md)) and a definitive `transaction.stateChanged` records the swap outcome and issues the resume (`settled`→settled, `rejected`/`cancelled`→rejected, `failed`→failed); an outcome the runtime already recorded is a no-op.

## 7. Paper mode expectations

Follow [executor.md section 8](../specs/executor.md#8-paper-execution). The stand-in derives the synthetic fill ID as `contentHash({schemaVersion: "paper-fill/1", logicalKey, adapter: "paper-adapter/1"})`, so a replay returns the same fill. It applies exact floor arithmetic with a declared 30 bps fee and rejects rather than fabricates a fill when the virtual balance is short.

## 8. Proving compatibility

The [executor conformance kit](../../apps/runtime/src/conformance/executor.ts) checks closed results, idempotent duplicates, body conflicts, key recomputation, closed request bodies, distinct repeat iterations, durable rejections and stale-generation refusal. The stand-in passes it in [`conformance.test.ts`](../../apps/runtime/src/conformance.test.ts).

The runtime's real client, [`dispatch/executor.ts`](../../apps/runtime/src/dispatch/executor.ts), now runs the kit against the real paper executor ([`executor-conformance.test.ts`](../../tests/executor-conformance.test.ts), 7/7); it maps statuses exactly as in [runtime HTTP clients §3](runtime-http-clients.md#3-one-error-mapping-both-sides-implement-it). To repeat it against another deployment of the executor, provide an `ExecutorHarness` whose `arrangeRun` creates an authorized paper run of `EXECUTOR_CONFORMANCE_STRATEGY` with at least 1 `paper.WETH` available and whose `revoke` pauses it.

The kit exports `EXECUTOR_CONFORMANCE_STRATEGY` (2026-10-08) because a real executor matches each intent against the deployed AST (executor spec §5 steps 7–9): the repeat test uses node `sell_small` inside a two-iteration repeat and the insufficient-input test uses node `sell_too_much`, so every intent the kit sends is one the approved strategy can produce. The in-memory stand-in does not check the AST and is unaffected.

## 9. Owner checklist

- [x] `POST /internal/v1/intents` and `GET /internal/v1/intents/{intentId}` with closed `action-intent/1` / `intent-result/1` validation. Evidence 2026-10-08: [`server.ts`](../../apps/executor/src/server.ts); boundary cases in [`executor-paper.test.ts`](../../tests/executor-paper.test.ts) (`REQUIRE_DB=1 pnpm check` 421/421, four consecutive runs; 481/481 on 2026-10-09 after merging `63d353e`).
- [x] Logical key recomputed from the capability; canonical-body idempotency; conflict and stale-generation answers as in section 4. Evidence: same file (scope, duplicate, concurrent-duplicate, pause and stale-generation cases).
- [x] Result states and fields as in section 5; no transaction hash in paper. Evidence: every answer is validated against `intent-result/1` before it is sent; paper rows have no transaction-hash column.
- [x] Definitive results of pending intents reported to the control API for resume. Evidence 2026-10-12: outbox consumer and resume in [`paper-stack.test.ts`](../../tests/paper-stack.test.ts) (pending fill → `reconcile()` → outbox → resume; runtime death after admission → outbox resume, one intent).
- [x] Conformance kit green against the real paper executor ([INT-2](AGENTS.md)). Evidence 2026-10-12: [`executor-conformance.test.ts`](../../tests/executor-conformance.test.ts) through the runtime's `HttpExecutor`, 7/7; with Postgres authority and control-API-issued capabilities in [`paper-stack.test.ts`](../../tests/paper-stack.test.ts) (`REQUIRE_DB=1 pnpm check` 518 pass, 0 skipped, twice).
- [ ] Branch evidence for `if`-gated nodes verified from persisted broker results ([D36](../decisions.md)) before live.
- [ ] Restricted database role for the hosted executor (grants listed in section 3a).
