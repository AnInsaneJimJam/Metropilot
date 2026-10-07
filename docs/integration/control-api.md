# Control API integration guide (for the API owner)

This guide is for the owner of `apps/api` (control API and API worker roles). It explains what the agent runtime expects from you, in the order you will build it, and how to prove your service is compatible. Rules live in the specs: [agent runtime](../specs/agent-runtime.md), [runtime](../specs/runtime.md), [API/data](../specs/api-and-data.md) and decisions [D32–D34](../decisions.md). Wire shapes live in [`packages/contracts/schemas`](../../packages/contracts/schemas/).

Status 2026-10-07: the runtime side is implemented and runs against an in-memory stand-in of your service, [`LocalControlPlane`](../../apps/runtime/src/local/control-plane.ts). Read that file next to this guide; every method there is a behavior you implement with one PostgreSQL transaction. Run `pnpm runtime:demo` to watch the whole flow.

**Not built yet: the runtime's HTTP clients and process entry point.** Until they exist, nothing calls your service; read [runtime HTTP clients](runtime-http-clients.md) for what is missing, the shared error mapping, retry rules and the contract gaps to settle with the runtime owner before you build your routes.

## 1. Who calls whom

```text
Envio / RPC ──finalized log──► ingestion (you) ──fan-out──► trigger_state rows ──fire──► run + assignment (you)
                                                                                          │
runtime ──poll──► you ──assignment-offer/1──► runtime                                      │
runtime ──GET run / wait / results / complete / timeline / heartbeat──► you                │
executor or broker reconciliation ──definitive result──► you ──resume assignment──► runtime ◄┘
```

The runtime never reads your database, never subscribes to events and has no timers. Everything that decides *when* a strategy runs is yours.

## 2. Tables this implies

Names are suggestions; behavior is not.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `deployments` | One row per agent deployment: generation, mode, desired state, manifest, artifact refs and hashes | Only the current generation may create operations |
| `trigger_state` | One row per (deployment, trigger): `trigger_type`, `feed_ref` (copied from the AST at deploy time), `generation`, `active`, crossing state (`baseline`, `observed_at`, `source_event_key`, `accepted_at`), `last_slot` | `unique(deployment_id, trigger_id)`; index `(feed_ref) where active` |
| `events` | Normalized finalized observations | Unique source key ([api-and-data.md](../specs/api-and-data.md)) |
| `runs` | `run_id`, deployment, generation, trigger, source event key, trigger stage times, status, current checkpoint, observation refs | `unique(run_id)` makes duplicate events harmless |
| `run_assignments` | Lease per run: assignment ID, owner, **fencing token** (monotonic per run), expiry | A newer token supersedes older ones |
| `run_operations` | One row per operation key: kind, node ID, iteration path, outcome, result ref, recorded result | `unique(run_id, operation_key)` |
| `timeline` | Notify entries | `unique(operation_key)` |

## 3. Ingestion and fan-out (decisions D32, D34)

Ingest push-first: each finalized pool event from the verified subscription becomes an observation `{sourceEventKey, feedRef, price, observedAt, receivedAt}` and enters fan-out immediately. A heartbeat read runs only for a feed that has been quiet for its catalog interval, so freshness baselines do not reset. Polling is the fallback until gate E10 passes.

Fan-out per observation:

```sql
SELECT ts.deployment_id, ts.trigger_id
FROM trigger_state ts JOIN deployments d USING (deployment_id)
WHERE ts.feed_ref = $1 AND ts.active AND d.desired_state = 'running' AND d.generation = ts.generation;
```

Then, for each row, in its own transaction:

1. `SELECT … FROM trigger_state WHERE deployment_id = $1 AND trigger_id = $2 FOR UPDATE`.
2. Call `transitionPrice(trigger, crossingState, observation, now)` from `@monad-hack/strategy`. Do not reimplement crossing, staleness or cooldown in SQL.
3. `UPDATE trigger_state` with the returned state.
4. If `fire`: insert the run (with `ON CONFLICT (run_id) DO NOTHING`) and its first assignment.
5. Commit.

Schedules are the same with `scheduleSlot(trigger, now, lastSlot)`; the source event key is `schedule:<slot>`.

**Run identity.** `runId = SHA-256(UTF-8(JSON.stringify([deploymentRevision, triggerId, sourceEventKey])))` as lower-case `0x` hex, exactly what the interpreter's `startRun` computes. `deploymentRevision` is an opaque string you choose per deployment generation (the stand-in uses `<deploymentId>/<generation>`); keep it stable for a generation. The runtime refuses an assignment whose `runId` differs from the interpreter's.

**Stage times (D34).** Record `trigger.observedAt` (from the observation), `trigger.acceptedAt` (when the transition fired) and `trigger.runCreatedAt` on the run and copy them into every assignment. The runtime adds its own stages and reports them.

## 4. Assignments

Build each [`runtime-assignment/1`](../../packages/contracts/schemas/runtime-assignment-1.schema.json) like this (the [normative example](../specs/agent-runtime.md#5-runtime-assignment-contract) is a contract fixture):

| Field | Value |
| --- | --- |
| `assignmentId` | New UUIDv7 per lease |
| `lease.fencingToken` | Previous token for this run + 1, as a decimal string |
| `lease.expiresAt` | Now + 30 s; heartbeats every 10 s extend it ([runtime.md](../specs/runtime.md)) |
| `deployment.generation` | Current generation as a decimal string |
| `deployment.runtimeImageDigest` | Digest of the pinned runtime image; the runtime refuses any other |
| `deployment.connectorVersions` | Manifest pins `{connectorRef: "MAJOR.MINOR.PATCH"}` for every connector the strategy uses |
| `run.triggerId` | The strategy's own trigger ID (for example `crossing`), never a UUID |
| `artifacts.strategyHash` | `compileStrategy(strategyJson, catalog).hash` |
| `artifacts.catalogHash` | `contentHash(catalog)` from `@monad-hack/contracts` |
| `trigger.*` | Stage times above |
| `capabilityRef` | Reference to the assignment capability; never the token itself |

Hand assignments out through `POST /internal/v1/runtime/assignments:poll` ([D33](../decisions.md)): a warm task long-polls with `assignment-poll/1`; answer `assignment-offer/1` with `assigned` (one assignment, once per lease), `none` (nothing yet; hold the request up to `waitSeconds`) or `drain`. A cold-start task (schedule-only or free paper) receives its assignment through the bootstrap route instead. Agents with price triggers must have a warm task while running.

## 5. Endpoints the runtime calls

All bodies are closed documents; validate with `validate(kind, body)` from `@monad-hack/contracts` before use. Every write carries `runId`, `assignmentId` and `fencingToken`; compare them with the current lease **inside the same transaction** as the write.

| Route | Body → response | Behavior you must guarantee |
| --- | --- | --- |
| `POST /internal/v1/runtime/assignments:poll` | `assignment-poll/1` → `assignment-offer/1` | One assignment per lease; `drain` when the runtime should stop |
| `GET /internal/v1/runtime/artifacts/{ref}` | → `{contentHash, text}` | Immutable; `contentHash` equals the assignment's hash |
| `GET /internal/v1/runs/{runId}` | → `run-state/1` | Current checkpoint (absent for a new run), the recorded result of the checkpoint's waiting operation (absent until one exists), and `observationRefs` (broker result IDs recorded in this run, in order) |
| `POST /internal/v1/runs/{runId}/wait` | `run-wait/1` | Atomically save the checkpoint and insert the operation row. The same operation again is a no-op; the same key with a different kind, node or iteration path is a conflict. A re-wait for an operation that already has an outcome keeps that outcome visible in `run-state` |
| `POST /internal/v1/runs/{runId}/results` | `run-result/1` | Only for an operation already saved by `wait`. `pending` may later become definitive; once definitive, the same outcome again is a no-op and a different one is a conflict. A `recorded` result with `resultRef` appends to `observationRefs` |
| `POST /internal/v1/runs/{runId}/complete` | `run-complete/1` | Only `completed` or `failed` checkpoints; conditional on the current lease |
| `POST /internal/v1/runs/{runId}/timeline` | `timeline-entry/1` | Idempotent by operation key; user-safe text only |
| `POST /internal/v1/runtime/heartbeat` | assignment ID + token | Extend the lease; refuse a stale token or a revoked generation |

The runtime saves the waiting checkpoint **before** it dispatches anything, so a crash at any point leaves you with enough to resume: a re-run loads the checkpoint, regenerates the identical command and operation key, and re-dispatches under the same key, which the broker and executor deduplicate.

## 6. Errors

Answer failures with an [`error-1`](../../packages/contracts/schemas/error-1.schema.json) body. The runtime depends on two codes in particular: `409 LEASE_FENCED` (a newer lease owns the run) and `409 GENERATION_REVOKED` (paused, stopped or replaced generation). The full status-to-behavior mapping is in [runtime HTTP clients §3](runtime-http-clients.md#3-one-error-mapping-both-sides-implement-it); it is the single place both sides implement.

## 7. Resuming after a pending operation

When a swap is pending (executor `202`) or an AI call is ambiguous (broker `unknown`), the runtime records `pending` and releases its process. The owning service later reaches a definitive state through its reconciliation path. Then you:

- **Swap (executor).** Record the definitive outcome on the operation row (`settled`, `rejected` or `failed`) with the intent ID as `resultRef`, then issue a new assignment for the same run (new assignment ID, next fencing token). The runtime loads `run-state/1`, hands the outcome to the interpreter and continues. The stand-in does this in `settleOperation()`.
- **Read or AI (broker).** Leave the operation `pending` and only issue the new assignment. The runtime re-requests under the same operation key, the broker answers with its reconciled record (no new provider call), and the runtime records it. Never record a broker `recorded` outcome yourself with only a reference: the interpreter needs the typed record and fails the run closed without it. The stand-in does this in `resumeBrokerOperation()`.

Settlement and reconciliation waits never hold a runtime process.

## 8. Pause, resume and redeploy

Pause sets the deployment inactive: from that moment `wait`, `results`, `complete`, `timeline` and `heartbeat` answer `GENERATION_REVOKED` for its runs, and `trigger_state` rows stop matching. External effects already dispatched stay with the executor or broker to reconcile. Resume or redeploy mints a new generation, resets crossing state (a fresh baseline is required) and never revives an old generation's assignments.

## 9. Proving compatibility

The [control API conformance kit](../../apps/runtime/src/conformance/control-api.ts) checks closed offers and artifacts, new-run and saved-wait state, wait and result idempotency and conflicts, fencing on every write and heartbeat, and terminal-only completion. The in-memory stand-in passes it in [`conformance.test.ts`](../../apps/runtime/src/conformance.test.ts).

To run it against your service you need the runtime's HTTP client, which is **not written yet** ([runtime HTTP clients](runtime-http-clients.md)); apps never import each other's source, so the kit reaches your service only through that client. Start with the loopback approach in [§1](runtime-http-clients.md#1-build-order-that-avoids-a-big-bang-integration). Provide a `ControlApiHarness` whose `arrangeRun` deploys the `ai_gated_purchase` preset and ticks its schedule through your test hooks, whose `expireLease` issues a newer lease, and whose `timelineCount` reads your timeline. Register it the way `conformance.test.ts` does.

## 10. Owner checklist

- [ ] `deployments`, `trigger_state`, `runs`, `run_assignments`, `run_operations`, `timeline` with the constraints above.
- [ ] Push-first ingestion, heartbeat for quiet feeds, fan-out with row lock and `transitionPrice`, schedule ticks with `scheduleSlot`.
- [ ] Run identity and assignment fields exactly as in section 4; stage times recorded.
- [ ] The eight routes in section 5 with closed-document validation and fencing in the same transaction.
- [ ] `LEASE_FENCED` / `GENERATION_REVOKED` errors.
- [ ] Resume assignment after a definitive result for a pending operation.
- [ ] Conformance kit green against the real service ([INT-1](AGENTS.md)).
