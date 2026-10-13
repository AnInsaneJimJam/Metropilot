# Control API integration guide (for the API owner)

This guide is for the owner of `apps/api` (control API and API worker roles). It explains what the agent runtime expects from you, in the order you will build it, and how to prove your service is compatible. Rules live in the specs: [agent runtime](../specs/agent-runtime.md), [runtime](../specs/runtime.md), [API/data](../specs/api-and-data.md) and decisions [D32–D34](../decisions.md). Wire shapes live in [`packages/contracts/schemas`](../../packages/contracts/schemas/).

Status 2026-10-08 (branch `feat/runtime-control-api`): **the runtime-facing control API is implemented** in [`apps/api/src/runtime-control/`](../../apps/api/src/runtime-control/): [`store.ts`](../../apps/api/src/runtime-control/store.ts) (PostgreSQL; the routes below plus the worker roles), [`app.ts`](../../apps/api/src/runtime-control/app.ts) (internal Fastify routes and capability checks), [`server.ts`](../../apps/api/src/runtime-control/server.ts) (`pnpm api:runtime`, local only) and migration [`0003_runtime_control.sql`](../../apps/api/migrations/0003_runtime_control.sql). The runtime's [HTTP client](../../apps/runtime/src/dispatch/control-api.ts) talks to it, and [`tests/runtime-control.test.ts`](../../tests/runtime-control.test.ts) passes the conformance kit both against the store and through HTTP, plus end-to-end paper runs, all on real PostgreSQL. The in-memory [`LocalControlPlane`](../../apps/runtime/src/local/control-plane.ts) remains the behavioral reference for the demo.

Update 2026-10-12 (branch `feat/lifecycle-executor-integration`): the user lifecycle and history are implemented too (section 11): paper estimates, `deployment/1` launches with a `deployment-manifest/1` record, pause/resume/stop, operations, run history, `audit-event/2` history and a live event stream, the executor capability exchange and the executor outbox consumer (migration [`0005`](../../apps/api/migrations/0005_deployment_lifecycle.sql)). `pnpm stack:dev` runs the whole local paper stack.

What is still yours (API owner): real ingestion from Envio/RPC feeding `ingestPrice` (gate E10), the selected workload-identity mechanism for the poll (gate E02), the hosted web login screen (API sign-in is done, D56), the API Broker (broker-audience capabilities), cloud provisioning (INF-3) and production hosting.

## 1. Who calls whom

```text
Envio / RPC ──finalized log──► ingestion (you) ──fan-out──► trigger_state rows ──fire──► run + assignment (you)
                                                                                          │
runtime ──poll──► you ──assignment-offer/1──► runtime                                      │
runtime ──GET run / wait / results / complete / timeline / heartbeat──► you                │
executor or broker reconciliation ──definitive result──► you ──resume assignment──► runtime ◄┘
```

The runtime never reads your database, never subscribes to events and has no timers. Everything that decides *when* a strategy runs is yours.

## 2. Tables (migrations 0003 and 0005)

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `deployments` | Minimal deployment: agent, pinned revision, mode, **generation**, desired state, strategy/catalog hashes, connector pins, runtime image digest | Revision must belong to the same agent and tenant; extend it in API-2, do not replace it |
| `artifacts` | Immutable strategy (canonical AST) and catalog bodies served to runtimes | Immutable; owned by one deployment |
| `trigger_state` | One row per (deployment, trigger): `trigger_type`, `feed_ref` copied from the AST, `generation`, `active`, crossing state, `last_slot` | Primary key `(deployment_id, trigger_id)`; index `(feed_ref) where active` |
| `runs` | Run identity, generation, revision, trigger, source event key, stage times, status (`queued` … `completed`/`failed`/`revoked`), checkpoint, recorded result, observation refs | `unique(run_id)` makes duplicate events harmless |
| `run_assignments` | Each lease: **fencing token** (monotonic per run), runtime, capability **hash** and expiry, lease expiry | `unique(run_id, fencing_token)`; the highest token is the current owner |
| `run_operations` | One row per operation key: kind, node, iteration path, outcome, result ref | Primary key `(run_id, operation_key)` |
| `timeline_entries` | Notify entries | Immutable; `operation_key` primary key |
| `runtime_workers` | Known runtimes and the operator drain flag | |
| `deployments` (0005 columns) | Network ref, policy and budget versions, resource profile, model pins, estimate, simulation account, `manifest` and `manifest_hash`; `desired_state` is `active`/`paused`/`stopping`/`stopped` ([D37](../decisions.md)) | Paper ⇔ simulation account; at most one non-stopped deployment per agent; FKs to `policies`, `estimates`, `simulation_accounts` |
| `deployment_operations` | Asynchronous lifecycle operations (`deploy`, `pause`, `resume`, `stop`) | Idempotency rows live in `control_requests` |
| `market_observations` | Finalized price observations from `ingestPrice`; the executor's recorded market | Primary key `(feed_ref, source_event_key)` |
| `tenant_streams`, `audit_events` | Per-tenant audit stream (`audit-event/2`), written in the same transaction as each change; `retained_after` is the retention floor (0014) | Immutable except `prune_audit_events` (never money rows); `unique(source)` makes republishing a no-op |

Normalized source events (`events`) are not part of this migration; ingestion owns them.

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
5. If the deployment is paper and its session or the tenant's UTC-day time is used up, refuse the run (`observation.skipped` with `QUOTA_SESSION`/`QUOTA_DAILY`); the worker's `enforcePaperQuotas()` then pauses the deployment (D58).
6. If the reason is `cooldown` or `stale`, or `transitionPrice` refused the observation, append an `observation.skipped` audit event with a vocabulary `reasonCode` (`TRIGGER_COOLDOWN`, `STALE_DATA`, or the language error code) so the user sees the blocked run (D57). Routine `baseline`, `no-crossing` and `out-of-order` results are not recorded.
7. Commit.

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
| `deployment.manifestHash` | `contentHash` of the deployment's `deployment-manifest/2` record (`/1` for deployments launched before migration 0012; D55) (`deployments.manifest_hash`); a deployment without one is not offered work |
| `deployment.runtimeImageDigest` | Digest of the pinned runtime image; the runtime refuses any other |
| `deployment.connectorVersions` | Manifest pins `{connectorRef: "MAJOR.MINOR.PATCH"}` for every connector the strategy uses |
| `run.triggerId` | The strategy's own trigger ID (for example `crossing`), never a UUID |
| `artifacts.strategyHash` | `compileStrategy(strategyJson, catalog).hash` |
| `artifacts.catalogHash` | `contentHash(catalog)` from `@monad-hack/contracts` |
| `trigger.*` | Stage times above |
| `capabilityRef` | Reference to the assignment capability; never the token itself |

Hand assignments out through `POST /internal/v1/runtime/assignments:poll` ([D33](../decisions.md)): a warm task long-polls with `assignment-poll/1`; answer `assignment-offer/1` with `assigned` (one assignment, once per lease), `none` (nothing yet; hold the request up to `waitSeconds`) or `drain`. A cold-start task (schedule-only or free paper) receives its assignment through the bootstrap route instead. Agents with price triggers must have a warm task while running.

## 5. Endpoints the runtime calls

Every route except the poll requires `Authorization: Bearer <capability>`; a capability authorizes exactly one assignment of one run, and every run ID and assignment ID in the request must match it (otherwise `403`). All bodies are closed documents; validate with `validate(kind, body)` from `@monad-hack/contracts` before use. Every write carries `runId`, `assignmentId` and `fencingToken`; compare them with the current lease **inside the same transaction** as the write.

| Route | Body → response | Behavior you must guarantee |
| --- | --- | --- |
| `POST /internal/v1/runtime/assignments:poll` | `assignment-poll/1` → `assignment-offer/2` | Workload-authenticated. One assignment per lease, delivered with its bearer capability; `drain` when the runtime should stop |
| `GET /internal/v1/runtime/artifacts/{ref}` | → `artifact/1` | Immutable; `contentHash` equals the assignment's hash; another deployment's artifact answers 404 |
| `GET /internal/v1/runs/{runId}` | → `run-state/1` | Current checkpoint (absent for a new run), the recorded result of the checkpoint's waiting operation (absent until one exists), and `observationRefs` (broker result IDs recorded in this run, in order) |
| `POST /internal/v1/runs/{runId}/wait` | `run-wait/1` | Atomically save the checkpoint and insert the operation row. The same operation again is a no-op; the same key with a different kind, node or iteration path is a conflict. A re-wait for an operation that already has an outcome keeps that outcome visible in `run-state` |
| `POST /internal/v1/runs/{runId}/results` | `run-result/1` | Only for an operation already saved by `wait`. `pending` may later become definitive; once definitive, the same outcome again is a no-op and a different one is a conflict. A `recorded` result with `resultRef` appends to `observationRefs` |
| `POST /internal/v1/runs/{runId}/complete` | `run-complete/1` | Only `completed` or `failed` checkpoints; conditional on the current lease |
| `POST /internal/v1/runs/{runId}/timeline` | `timeline-entry/1` | Idempotent by operation key; user-safe text only |
| `POST /internal/v1/runtime/heartbeat` | `runtime-heartbeat/1` → `runtime-lease/1` | Extend the lease and the same capability (not rotated, so requests in flight stay valid); refuse a stale token or a revoked generation |
| `POST /internal/v1/runtime/capabilities:exchange` | `{"audience": "executor"}` → `audience-capability/1` | Current lease of an active generation only; a D35 token scoped to the run, expiring no later than the control capability ([D38](../decisions.md)) |

The runtime saves the waiting checkpoint **before** it dispatches anything, so a crash at any point leaves you with enough to resume: a re-run loads the checkpoint, regenerates the identical command and operation key, and re-dispatches under the same key, which the broker and executor deduplicate.

## 6. Errors

Answer failures with an [`error-1`](../../packages/contracts/schemas/error-1.schema.json) body. The runtime depends on two codes in particular: `409 LEASE_FENCED` (a newer lease owns the run) and `409 GENERATION_REVOKED` (paused, stopped or replaced generation). The full status-to-behavior mapping is in [runtime HTTP clients §3](runtime-http-clients.md#3-one-error-mapping-both-sides-implement-it); it is the single place both sides implement.

## 7. Resuming after a pending operation

When a swap is pending (executor `202`) or an AI call is ambiguous (broker `unknown`), the runtime records `pending` and releases its process. The owning service later reaches a definitive state through its reconciliation path. Then you:

- **Swap (executor).** Record the definitive outcome on the operation row (`settled`, `rejected` or `failed`) with the intent ID as `resultRef`, then issue a new assignment for the same run (new assignment ID, next fencing token). The runtime loads `run-state/1`, hands the outcome to the interpreter and continues. Implemented: the control worker's `consumeExecutorOutbox()` does this for every definitive `transaction.stateChanged` outbox row (the stand-in uses `settleOperation()`). A row whose outcome conflicts with an already recorded one is still published, with `payload.conflict` set, and never retried, so one bad row cannot block the rest of the outbox.
- **Read or AI (broker).** Leave the operation `pending` and only issue the new assignment. The runtime re-requests under the same operation key, the broker answers with its reconciled record (no new provider call), and the runtime records it. Never record a broker `recorded` outcome yourself with only a reference: the interpreter needs the typed record and fails the run closed without it. The stand-in does this in `resumeBrokerOperation()`.

Settlement and reconciliation waits never hold a runtime process.

## 8. Pause, resume and stop

Pause sets `desired_state = 'paused'`: from that moment `wait`, `results`, `complete`, `timeline`, `heartbeat` and the capability exchange answer `GENERATION_REVOKED` for its runs, the executor refuses new intents and cancels reserved ones before filling, and `trigger_state` rows stop matching. External effects already dispatched keep reconciling. Resume mints a new generation (`active`), revokes the unfinished runs of the old generation, resets crossing state (a fresh baseline is required) and never revives an old generation's assignments. Stop sets `stopping` after revoking unfinished runs (the executor refuses new intents and cancels reserved ones) and `stopped` once no intent of the deployment is open, at once when nothing is open, otherwise from the worker's `finaliseStopping()`; stop is idempotent while stopping and pause/resume are refused (D59). A new launch, after `stopped`, creates a new deployment. Each change writes a `deployment.stateChanged` audit event.

## 9. Proving compatibility

The [control API conformance kit](../../apps/runtime/src/conformance/control-api.ts) checks closed offers and artifacts, new-run and saved-wait state, wait and result idempotency and conflicts, fencing on every write and heartbeat, and terminal-only completion. Three implementations pass it:

| Implementation | Where |
| --- | --- |
| In-memory `LocalControlPlane` | [`apps/runtime/src/conformance.test.ts`](../../apps/runtime/src/conformance.test.ts) |
| `RuntimeControlStore` on PostgreSQL, in process | [`tests/runtime-control.test.ts`](../../tests/runtime-control.test.ts) |
| Runtime `HttpControlApi` → internal Fastify app → PostgreSQL | same file |

Run them with a database: `REQUIRE_DB=1 pnpm check` (see [README](../../README.md) setup). If you change a route or a table, keep all three green.

To run the API locally for a runtime: `pnpm db:migrate`, then `pnpm api:runtime` (loopback `127.0.0.1:3002`, development workload header `x-runtime-workload: <runtimeId>`, worker loop ticking schedules and reclaiming expired leases every second).

## 10. Owner checklist

- [x] Tables with the constraints above (migration 0003; extend `deployments` in API-2).
- [ ] Push-first ingestion from the verified source and heartbeat reads for quiet feeds, calling `ingestPrice` (the fan-out with row lock and `transitionPrice` is implemented); schedule ticks are implemented in the local worker loop.
- [x] Run identity and assignment fields as in section 4; stage times recorded.
- [x] The eight routes in section 5 with closed-document validation, bearer capabilities and fencing in the same transaction.
- [x] `LEASE_FENCED` / `GENERATION_REVOKED` errors; `INTERNAL_ERROR` for defects, `PROVIDER_UNAVAILABLE` only for a lost database connection.
- [x] Resume assignment after a definitive result for a pending operation; revoke unfinished runs when a generation is superseded.
- [x] Conformance kit green through the runtime HTTP client against PostgreSQL ([INT-1](AGENTS.md)).
- [ ] Production workload identity (E02), audience-scoped broker/executor capabilities, hosting.
- [x] User lifecycle and history (section 11), executor capability exchange and executor outbox consumer (2026-10-12).

## 11. User lifecycle and history

Implemented in [`apps/api/src/lifecycle.ts`](../../apps/api/src/lifecycle.ts) and routed in [`app.ts`](../../apps/api/src/app.ts); the studio's Operate stage uses them. Every mutation takes an `Idempotency-Key` (same key and body replays the stored response; a different body is `409 IDEMPOTENCY_CONFLICT`).

| Route | Behavior |
| --- | --- |
| `POST /v1/agents/{id}/estimates` | `paper-estimate/1`: runs per day and worst-case AI calls from the saved revision; creates policy version 1 from the agent's experience if none exists ([D39](../decisions.md)); expires in 15 minutes |
| `POST /v1/agents/{id}/deployments` | `deployment/1` → `202` `deployment-operation/1`. Paper only (`422 CAPABILITY_DISABLED` for live). Checks the estimate (agent, revision, expiry → `409 ESTIMATE_EXPIRED`), budget and policy versions, the network and resource profile, every selected connector and capability, and that every connector, capability and model profile the strategy uses is selected (`422 UNSUPPORTED_CAPABILITY`). One open deployment per agent (`409`). Creates the simulation account, manifest, deployment, artifacts and trigger rows in one transaction |
| `POST /v1/agents/{id}/pause`, `/resume`, `/stop` | `202` `deployment-operation/1` (section 8) |
| `GET /v1/operations/{id}` | `deployment-operation/1` |
| `GET /v1/quota` | `paper-quota/1`: the user's running agents, UTC-day and session paper time; launch/resume over a limit → `429 LIMIT_EXCEEDED` with `details.reason` (D58) |
| `GET /v1/agents/{id}/deployment` | `agent-deployment/1`: the open deployment, else the latest |
| `GET /v1/agents/{id}/runs?limit&cursor` | `run-summary/1` items, newest first |
| `GET /v1/runs/{runId}` | `run-detail/1`: trigger stage times, operations with outcomes, timeline entries |
| `GET /v1/agents/{id}/events?after&limit` | `audit-event/2` items after a sequence, oldest first; a cursor below the retention floor → `410 CURSOR_EXPIRED` with `details.resumeFrom` |
| `GET /v1/agents/{id}/stream` | Server-sent `audit` events (`id:` is the sequence); `Last-Event-ID` resumes; a pruned cursor gets `event: reset` (`id:` = `resumeFrom`) and the stream closes; delivery never controls execution |
| `GET /v1/catalog` | Adds `paperVersions`: enabled paper connector and model profile versions, for building a launch request |

Evidence: [`tests/paper-stack.test.ts`](../../tests/paper-stack.test.ts) runs launch → schedule → runtime (HTTP clients) → real paper executor → outbox → history and stream, plus pending fills, runtime death after admission, pause/resume/stop and launch validation, on PostgreSQL.
