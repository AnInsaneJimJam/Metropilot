# Executor integration guide (for the executor owner)

This guide is for the owner of `apps/executor`. It covers only the runtime-facing contract: what the runtime sends, what it needs back and how a pending effect returns to the run. Admission, policy, reservations, signing and reconciliation are defined in the [executor specification](../specs/executor.md); wire shapes are [`action-intent-1`](../../packages/contracts/schemas/action-intent-1.schema.json) and [`intent-result-1`](../../packages/contracts/schemas/intent-result-1.schema.json).

Status 2026-10-07: the runtime builds and sends `ActionIntent`s and handles every result state. It runs against an in-memory paper executor, [`PaperExecutor`](../../apps/runtime/src/local/paper-executor.ts), which shows the expected behavior in about a hundred lines. Run `pnpm runtime:demo` to see admission, duplicates, crash recovery and settlement.

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

## 7. Paper mode expectations

Follow [executor.md section 8](../specs/executor.md#8-paper-execution). The stand-in derives the synthetic fill ID as `contentHash({schemaVersion: "paper-fill/1", logicalKey, adapter: "paper-adapter/1"})`, so a replay returns the same fill. It applies exact floor arithmetic with a declared 30 bps fee and rejects rather than fabricates a fill when the virtual balance is short.

## 8. Proving compatibility

The [executor conformance kit](../../apps/runtime/src/conformance/executor.ts) checks closed results, idempotent duplicates, body conflicts, key recomputation, closed request bodies, distinct repeat iterations, durable rejections and stale-generation refusal. The stand-in passes it in [`conformance.test.ts`](../../apps/runtime/src/conformance.test.ts).

To run it against your service you need the runtime's executor client, which is **not written yet** ([runtime HTTP clients](runtime-http-clients.md)); it will map your statuses exactly as in [§3 there](runtime-http-clients.md#3-one-error-mapping-both-sides-implement-it). Provide an `ExecutorHarness` whose `arrangeRun` creates an authorized paper run with at least 1 `paper.WETH` available and whose `revoke` pauses it.

## 9. Owner checklist

- [ ] `POST /internal/v1/intents` and `GET /internal/v1/intents/{intentId}` with closed `action-intent/1` / `intent-result/1` validation.
- [ ] Logical key recomputed from the capability; canonical-body idempotency; conflict and stale-generation answers as in section 4.
- [ ] Result states and fields as in section 5; no transaction hash in paper.
- [ ] Definitive results of pending intents reported to the control API for resume.
- [ ] Conformance kit green against the real paper executor ([INT-2](AGENTS.md)).
