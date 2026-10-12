# API, configuration, and data contracts

Version: `api/1`, `deployment/1`, `event/1`, `audit-event/1`. Owner: `packages/contracts`, with API/data-owner approval. JSON Schemas and generated types for the DeploymentRequest, error body, source event, audit event and asset identity exist in [`packages/contracts/schemas`](../../packages/contracts/schemas); the DeploymentManifest schema, migrations and endpoints are future implementation. Section 9 records the choices the schemas made where this document was silent.

## 1. Wire conventions

HTTPS JSON under `/v1`; schemas use JSON Schema 2020-12 with closed executable objects. Request bodies and model/tool outputs are validated, not cast. Server-generated resource IDs are UUIDv7 strings; provider IDs remain namespaced opaque strings. Node IDs and catalog references follow their own documented formats. Timestamps are UTC RFC 3339 with milliseconds, durations integer seconds, chain block heights decimal integer strings, asset atomic amounts decimal integer strings, and hash bytes lower-case `0x` hex. USD valuation is a separate integer `usdMicros` string.

Tenant/user/agent ownership comes from authentication plus server lookup, never trusted body claims. Database tables use composite tenant/ID keys for owned references. EVM address input is checked for valid length/encoding and checksum when mixed case; normalize comparison form separately from display. Asset identity is `(networkRef, chainId, contractAddress)` or native-asset marker, never symbol alone. Mainnet, testnet, fork and paper registries are distinct.

Every mutation accepting retries has `Idempotency-Key`; scope is authenticated actor + method + route. Store request hash and result atomically. Same key/same body returns original operation/result; changed body returns `409 IDEMPOTENCY_CONFLICT`. Keep financial-operation keys for the ledger's retention period; nonfinancial keys at least seven days. Draft writes use `If-Match` revision; stale revisions return `409 REVISION_CONFLICT` with current revision and no silent overwrite.

List endpoints use opaque stable cursor and `limit` 1–100, default 25; deterministic order by created time then ID. Timestamps are not a deduplication key. Request logs include trace ID and request ID without secrets.

## 2. Domain vocabulary

| Entity | Meaning |
| --- | --- |
| User / tenant | Authenticated account; one user per tenant in MVP |
| Agent | User-owned configuration and wallet association; long-lived identity |
| Strategy revision | Immutable canonical AST, editor workspace, hash and validation report |
| Deployment | Immutable resolved manifest plus desired/observed lifecycle and generation |
| Run | One accepted trigger firing against a deployment and source event/slot |
| Observation | Provenanced, timestamped external or recorded data |
| Intent | Typed proposed financial action, before quote/build/sign |
| Transaction attempt | Concrete signed/submitted transaction for an intent, approval, withdrawal or sweep |
| Ledger journal | Balanced immutable per-asset financial postings |
| Reservation | Temporary unavailable amount/counter capacity linked to an operation |
| Usage record | Model/data/compute consumption at a versioned rate |
| Audit event | Immutable domain event describing who/what changed state |

## 3. Draft and deployment contract

The client submits a `DeploymentRequest` referencing saved immutable strategy and catalog choices, not a cloud config file to execute. Required fields: `schemaVersion`, `agentId`, `strategyRevisionId`, `mode`, `networkRef`, `connectorSelections`, `modelProfiles`, `resourceProfileRef`, `budgetVersion`, `policyVersion`, `estimateId`. Live requests also reference a current step-up approval; paper requests use a simulation-account/quota association resolved server-side.

Example paper request; IDs are synthetic but well-formed. The referenced fixture catalogs and rows must exist in G1 test data. This does not provision a real network or model account.

```json
{
  "schemaVersion": "deployment/1",
  "agentId": "019a0000-0000-7000-8000-000000000001",
  "strategyRevisionId": "019a0000-0000-7000-8000-000000000002",
  "mode": "paper",
  "networkRef": "paper-monad",
  "connectorSelections": [
    {
      "ref": "paper.uniswap",
      "version": "1.0.0",
      "capabilities": ["price.read", "swap.exactInput"]
    }
  ],
  "modelProfiles": [],
  "resourceProfileRef": "paper-small-v1",
  "budgetVersion": 1,
  "policyVersion": 1,
  "estimateId": "019a0000-0000-7000-8000-000000000003"
}
```

The API compiles/resolves this into a `DeploymentManifest`:

| Field | Source and rule |
| --- | --- |
| `schemaVersion`, `deploymentId`, `agentId`, `tenantId`, `generation` | Server identities and format version |
| `mode`, `network` | Verified registry snapshot including chain ID/RPC reference/finality policy; paper cannot resolve live signer |
| `strategy` | Revision ID, AST content hash, AST artifact reference, language version |
| `connectors` | Selected capability manifest versions/hashes and resolved contract/data registry references |
| `models` | Profile ID, provider/model ID, supported parameters, region/workspace, rate-card version, credential reference |
| `resource` | Approved resource-profile version and immutable runtime image digest |
| `walletRef` or `simulationAccountRef` | Exactly one, selected by mode; no private key |
| `policyRef`, `budgetVersion`, `estimateRef` | Approved versions; current stricter policy also checked at action time |
| `createdAt`, `configHash` | Creation timestamp and JCS/SHA-256 hash excluding the hash field itself |

Implementation (2026-10-13, D42): `deployment-manifest/2` carries `catalogPins`, the exact `catalog_versions` rows (kind, ref, version, content hash) the deployment's catalog artifact (`catalogHash`) was resolved from; compilation and launch never use the synthetic catalog. A disabled or malformed selected version refuses launch with its reason, and a resume refuses when a pinned row was disabled. Paper and live registries are resolved separately.

Manifest artifact is read-only and authenticated; runtime confirms its hash against the deployment record delivered by the control plane. User export strips internal credential/artifact references. Immutable deployment config does not freeze user authority forever: current revocation, budget availability, and policy tightening override it.

## 4. Public HTTP endpoints

| Endpoint | Request / response behavior |
| --- | --- |
| `POST/DELETE /v1/auth/session` | Hosted only: exchange a verified identity-provider token for an HTTP-only application session cookie / revoke it ([D43](../decisions.md)) |
| `GET /v1/catalog` | Network, connector/action, model/profile, resource and rate versions; readiness and reason. Implemented for paper: the catalog resolved from `catalog_versions` plus the newest usable connector/model versions (D42) |
| `POST /v1/agents` | Create draft agent; does not launch or create funded wallet |
| `GET/PATCH /v1/agents/{id}` | Read/update mutable name and draft references with revision protection |
| `POST /v1/agents/{id}/strategy-revisions` | Workspace/AST submission; immutable revision and validation report |
| `POST /v1/strategies/validate` | Bounded ephemeral validation; errors with node/field paths; no execution |
| `POST /v1/agents/{id}/estimates` | Strategy/profile/frequency/horizon inputs → versioned expiring runway/cost quote |
| `POST /v1/agents/{id}/wallet` | Gated custody provisioning; returns network/accepted asset/address; idempotent |
| `GET /v1/agents/{id}/balances` | Finalized balances, pending deposits, per-asset buckets/reservations and valuation time |
| `POST /v1/agents/{id}/allocations` | Expected version + proposed bucket amounts → conserved allocation/version |
| `PUT /v1/agents/{id}/policy` | Expected version + within-platform limits + approval if increased authority |
| `POST /v1/agents/{id}/deployments` | DeploymentRequest → `202` operation ID and status URL |
| `POST /v1/agents/{id}/pause` | Immediately revoke new action authority, then async compute drain |
| `POST /v1/agents/{id}/resume` | Validate fresh deployment/estimate references and start new generation |
| `POST /v1/agents/{id}/stop` | Pause plus teardown; leave unresolved effects under reconciliation |
| `POST /v1/agents/{id}/withdrawals` | Step-up + verified destination + amount/asset → reserved withdrawal operation |
| `GET /v1/agents/{id}/runs` | Run state and bounded summaries; detail via `GET /v1/runs/{id}` |
| `GET /v1/agents/{id}/events` | Cursor-paginated audit history |
| `GET /v1/agents/{id}/stream` | SSE with resumable event cursor; derived from durable audit rows |
| `GET /v1/operations/{id}` | Provisioning/withdrawal/etc. state with safe error details |
| `GET /v1/agents/{id}/export` | Sanitized strategy/capability configuration; no signing grants or server secrets |

SSE is authenticated with the application's session; never put long-lived bearer tokens in URLs. `Last-Event-ID` resumes from a durable monotonically increasing tenant-stream sequence. If retention has removed the cursor, return a reset instruction and fetch current state/history; do not imply no events occurred. Slow clients reconnect; stream delivery does not control execution.

## 5. Internal interfaces

Internal requests use workload identity plus scoped runtime capability, independent of public user session cookies. They are not exposed through a generic proxy route.

| Interface | Required behavior |
| --- | --- |
| API `POST /internal/v1/runs/{id}/observations` | Validate read capability and freshness; return typed/provenanced observation, metering paid data |
| API `POST /internal/v1/runs/{id}/model-calls` | Validate model profile and input/schema; reserve cost; dispatch once; return result or durable pending state |
| API `POST /internal/v1/runs/{id}/checkpoints` | Compare lease/generation; save step result and next work atomically |
| Executor `POST /internal/v1/intents` | Accept typed intent only, infer identity, dedup; reserve/authorize or reject |
| Executor `GET /internal/v1/intents/{id}` | Same-agent status/result; redact signing bytes/provider credentials |
| Provider webhook ingress | Provider-specific authenticity/replay validation; durable event insert before acknowledgement |

`ActionIntent` fields: version, run ID, node ID, iteration path, connector reference/version, action type, token-in/out refs, amount spec, maximum slippage, observation references, and client-derived logical key. Executor recomputes the logical key and fills authoritative tenant/wallet/mode/generation; it never trusts a proposed recipient/nonce/calldata from runtime. Match the intent to the approved AST node and verify prerequisite/branch evidence from persisted broker results; runtime cannot introduce another action under a valid node ID. Duplicate intent returns the original frozen parameters/result. The exact HTTP behavior, logical-key derivation, state machines and safe result contract are authoritative in the [executor specification](executor.md).

## 6. Event envelope and errors

Normalized source events carry version, source, source key, network, observedAt, receivedAt, sequence/block coordinates when applicable, typed payload, and provenance hash. Audit events add tenant/agent/run/intent IDs, actor, trace ID, event type, redacted payload, and monotonic stream sequence. Audit types include deployment state, observation accepted/skipped, run step, model usage, policy denial, reservation change, transaction state, ledger settlement, and resource health.

Source dedup keys: chain logs use `(chainId, blockHash, txHash, logIndex)` plus canonicality; provider events use `(provider, subscription, deliveryEventId)` when stable, otherwise a documented content digest/time key; schedules use `(deployment, trigger, slot)`. Multiple websocket/webhook deliveries are the same event only when their canonical source identity matches.

Error body fields: `code`, readable `message`, `requestId`, optional `nodeId`, `fieldPath`, `retryable`, and safe `details`. Codes include `UNAUTHENTICATED`, `FORBIDDEN`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `SCHEMA_INVALID`, language validation codes, `CAPABILITY_DISABLED`, `ESTIMATE_EXPIRED`, `FUNDING_PENDING`, `INSUFFICIENT_BUDGET`, `POLICY_DENIED`, `STALE_OBSERVATION`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `INTERNAL_ERROR`, `RECONCILIATION_REQUIRED`. Unexpected application faults use 500 `INTERNAL_ERROR` with `retryable: false`; recognized connection/availability failures use 503 `PROVIDER_UNAVAILABLE`. `retryable` never means a client may issue a new financial idempotency key.

Use 400 for malformed syntax, 401/403 for identity/authority, 404 for nonexistent or inaccessible owned resources, 409 for version/state conflicts, 422 for semantic validation/policy/funding constraints, 429 for quota, 503 for unavailable dependencies, and 202 for accepted durable operations. Avoid leaking another tenant's object existence.

## 7. Relational model and constraints

All money arithmetic is exact `numeric(78,0)` for atomic quantities with nonnegative checks where relevant; chain amounts are bounded to uint256 at validation. Precision/scale of provider rates is stored as integer numerator/denominator or normalized fixed decimal strings with a bounded schema. JSONB holds versioned documents, not ad hoc substitutes for indexed financial columns.

| Relation | Key columns / constraints |
| --- | --- |
| `tenants`, `users` | Unique external auth subject; active/suspended state. Implemented as `tenants` plus `identities (provider, subject) → tenant` and `sessions` (token SHA-256, expiry, revocation; migration 0007, D43) |
| `agents` | Tenant/ID, mode-independent draft refs, name, version; composite ownership key |
| `strategy_revisions` | Tenant/ID, agent, content hash, language version, AST/workspace, validation; immutable |
| `deployments` | Agent generation unique; manifest/hash, desired/observed state, timestamps; partial uniqueness for active generation |
| `catalog_versions` | Kind/ref/version/hash, readiness, verified chain/address/capability metadata; immutable versions |
| `policies`, `estimates` | Tenant/agent/version, limits or priced assumptions/expiry; immutable approved snapshots |
| `wallets` | Tenant/agent/network/provider ID/address unique; custodial ownership and status |
| `simulation_accounts` | Agent/session, virtual initial portfolio; disjoint from wallets |
| `events`, `event_cursors` | Unique source key, provenance/canonicality; cursor per subscription/network |
| `trigger_state` | Deployment/trigger unique; last accepted observation/baseline/cooldown |
| `runs`, `node_results` | Unique trigger-source key; unique `(run,node,iterationPath)` checkpoint/result |
| `intents` | Unique logical effect key; frozen resolved amount, policy/quote refs, state |
| `nonce_slots` | Unique wallet/chain/nonce; logical action owner and current attempt |
| `transaction_attempts` | Intent/parent action, nonce slot, signed hash/provider request ID unique, state, finalized receipt |
| `ledger_accounts`, `journals`, `postings` | Per-asset accounts; unique posting operation key; balanced-journal validation before commit |
| `reservations`, `spend_windows` | Unique operation/asset hold; active hold totals and authorized UTC-day counters |
| `usage_records` | Unique logical billable slice or provider request; actual/unknown status, rate and reservation refs |
| `jobs` | Unique logical job key; due time, lease/fencing token, payload version and attempts |
| `audit_events` | Append-only tenant sequence, actor, type, target, safe payload; immutable |
| `idempotency_records` | Actor/route/key unique, body hash, operation/result reference, expiry |

Live deposits, withdrawals and treasury sweeps are typed financial operations associated with intents/transaction attempts and dedicated indexed metadata; they cannot masquerade as strategy swaps. Store provider invoice lines as platform records linked to usage, separate from tenant-visible charges. Retention and access rules are in [security](security.md).

Use indexes on ready jobs `(status,availableAt)`, tenant/agent time lists, event source key, open reservations, unresolved transactions by wallet, and stream sequence. Do not index every JSON path speculatively. Concurrent tests run against a real Postgres instance and non-superuser roles.

## 8. Atomic transactions and compatibility

Atomic units: deployment + job; event acceptance + trigger state + run/job; ledger journal + balance updates + reservation settlement + audit; policy update + revocation generation; intent creation + holds + notional counters; nonce ownership + prepared attempt. External network calls occur after commit and have their own durable dispatch/recovery state.

Schema migrations are versioned and forward-only in production with tested recovery. Changing a language interpretation requires a new language version; existing deployments keep their interpreter image/version until explicit migration. Unknown versions fail rather than guessing. Example records are test fixtures to be validated at G1, not live environment values.

## 9. Schema decisions recorded at G1 (CON-1/CON-3)

These resolve gaps in sections 1–6 with the smallest choice; the schema files are authoritative for exact patterns and bounds.

| Topic | Decision |
| --- | --- |
| Identifiers | UUIDv7 is lower-case with the RFC 9562 variant. Catalog references match `^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$` (≤128 characters), so they cannot be URLs or addresses. Capability and event type IDs are dotted (`price.read`). Catalog versions are exact `MAJOR.MINOR.PATCH`. Provider IDs are `namespace:opaque`. |
| Numbers | Block heights and stream sequences are decimal strings. Chain IDs, record versions (`budgetVersion`, `policyVersion` ≥ 1), and log indexes are bounded JSON integers. Atomic amounts are checked against uint256 by a named `uint256` format. Trace IDs use the W3C 32-hex form. |
| DeploymentRequest | A live request carries `stepUpApprovalId` (UUIDv7); a paper request must not. `modelProfiles` items are pinned `{ref, version}` objects like connector selections. Bounds: at most 16 connector selections, 1–32 unique capabilities each, at most 8 model profiles. `tenantId`/owner fields are rejected as unknown fields. |
| Asset identity | A tagged object: `erc20` (`networkRef`, `chainId`, `contractAddress`), `native` (`networkRef`, `chainId`), or `paper` (`networkRef`, `assetRef`; no chain ID or address). Documents carry the normalized lower-case address. The API verifies the EIP-55 checksum of mixed-case input before normalizing it. |
| Error body | Route-versioned (`/v1`), so it has no `schemaVersion`. `requestId` is a UUIDv7, `fieldPath` is an RFC 6901 JSON Pointer, and `details` holds at most 16 scalar entries. `NOT_FOUND` (404) and `MALFORMED_REQUEST` (400 syntax) join the code list, which also includes the language codes. |
| Source event `event/1` | Fields: `source` (catalog ref), `sourceKey`, `networkRef`, `observedAt`, `receivedAt`, optional `sequence`, `payloadType`, `payload` (object, ≤64 fields), and `provenanceHash` (SHA-256 of the JCS-canonical raw record). `sourceKey` kinds: `chainLog` (with `blockNumber` and `finality: provisional/finalized`), `providerDelivery`, `providerDigest` (with `observedAt` as the time component), and `schedule`. |
| Audit event `audit-event/1` | A separate version from `event/1`. Fields: `sequence`, `tenantId`, optional `agentId`/`runId`/`intentId`, `actor`, `traceId`, `type`, `occurredAt`, and redacted `payload`. Actor kinds are `user`/`operator` (with account `id`) and `controlPlane`/`runtime`/`executor`/`system` (without one). Types: `deployment.stateChanged`, `observation.accepted`, `observation.skipped`, `run.step`, `model.usage`, `policy.denied`, `reservation.changed`, `transaction.stateChanged`, `ledger.settled`, `resource.health`. |
| Byte ceilings | `parse()` checks these before JSON parsing: strategy 256 KiB, DeploymentRequest 1 MiB, source/audit event 64 KiB, error body 16 KiB, asset identity 4 KiB. |
| Runtime contracts (2026-10-07) | `action-intent/1`, `intent-result/1`, `runtime-assignment/1`, `assignment-poll/1`, `assignment-offer/1`, `run-state/1`, `run-wait/1`, `run-result/1`, `run-complete/1`, `timeline-entry/1`, `broker-request/1`, `broker-result/1` ([agent runtime](agent-runtime.md) sections 5–8, [executor](executor.md) section 4). Shared `common` additions: `generation` and `fencingToken` (positive decimal strings), `iterationPath`, `hostOperationKind`, `boundRecord` (evaluated literals only), `safeText`, `opaqueKey`. Keys: `intentKey()` (`intent-key/1`) and `operationKey()` (`operation-key/1`; a swap's operation key is its intent key). Run documents embed the language core's `strategy-run/2` checkpoint by reference. Open payloads are limited to recorded read/AI records, which the interpreter types. Error codes gain `LEASE_FENCED`, `GENERATION_REVOKED` and `INTERNAL_ERROR` (a defect; `PROVIDER_UNAVAILABLE` only for a lost dependency). 2026-10-08: `assignment-offer/2` (adds the per-assignment `capabilityGrant`; supersedes `/1`), `artifact/1` (≤1 MiB), `runtime-heartbeat/1` and `runtime-lease/1`; tables in [migration 0003](../../apps/api/migrations/0003_runtime_control.sql). Ceilings: run-wait/complete 256 KiB, run-state 320 KiB, run-result and broker-result 64 KiB, broker-request and timeline 32 KiB, assignment documents and intent documents 16 KiB, poll 4 KiB. |
| Lifecycle and history (2026-10-12) | `deployment-manifest/1` (first producer: the paper launch; its hash is the assignment `manifestHash`), `audience-capability/1` (executor capability exchange, D38), `audit-event/2` (supersedes `/1`: `runId` is the run hash, adds `deploymentId`, `run.stateChanged`, `timeline.entry`; D40) and the user documents of `control-lifecycle-1` (`paper-estimate/1`, `deployment-operation/1`, `agent-deployment/1`, `run-summary/1`, `run-detail/1`). The D35 capability format lives in `packages/contracts/src/capability.ts` (server-only export). Tables in [migration 0005](../../apps/api/migrations/0005_deployment_lifecycle.sql). |
| Catalog pins (2026-10-13) | `deployment-manifest/2` supersedes `/1` for new deployments: adds required `catalogPins` (1–256 `{kind, ref, version, contentHash}`, ordered by kind then ref, one per kind and ref; the uniqueness is checked by the producer). Ceiling 64 KiB. [Migration 0006](../../apps/api/migrations/0006_catalog_pins.sql) lets `deployments.manifest` hold either version and requires non-empty pins on `/2` (D42). |
