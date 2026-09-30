# Runtime, execution and recovery

Version: 1.0 design baseline. Owners: API lifecycle worker, isolated runtime, privileged executor, infrastructure.

## Lifecycle and generations

Agent configuration lifecycle: `draft → validated → provisioning → running → pausing → paused → provisioning` for resume, and `provisioning/running → failed`, `paused/failed → stopping → stopped`. Funding readiness is a separate field; paper mode never waits for a live deposit. A stopped agent can launch a new deployment; stopped generations never revive. Deletion tombstones configuration only after pending effects are reconciled and funds disposition is known.

Each deployment has a monotonically increasing generation, immutable manifest hash and desired state. Only one generation per agent may create new operations. A worker lease and generation are distinct: lease fences who completes a job, generation fences whose requests are authorized. Resume/redeploy mints a new generation and revokes old runtime capabilities. Old financial effects remain reconcilable regardless of runtime generation.

Provisioning records desired state and an idempotent cloud-operation key before cloud launch. Resources carry agent/deployment tags. A reconciler discovers successful launches after API timeout, removes duplicates, and cleans failed resources. Activation occurs only after manifest/image verification, health check, budget lease, and capability issue. Runtime cannot launch itself or ask for a larger machine.

## Jobs and observation delivery

`jobs` rows carry logical key, kind, payload version, tenant/agent, status, attempt, availableAt, leaseOwner, leaseUntil and fencing token. Claim ready rows atomically with `FOR UPDATE SKIP LOCKED`, update lease/token, then commit. Heartbeat every 10 seconds for a 30-second lease. Result writes compare the current token; stale workers lose authority. Long waits become persisted states and release worker slots.

One active run per agent, with a 1,000-event backlog ceiling. Serialize trigger-state changes and run creation. Duplicate event and run keys are constrained in the DB. Market price observations may coalesce to latest under load **before acceptance**, while chain financial/reconciliation events must be durably retained. Mark dropped/coalesced observations and reset crossing baselines after gaps. Never silently delete deposits, transactions or unsettled intents to shed load.

Schedule slots use UTC and immutable anchor/interval. On recovery, coalesce missed slots to the most recent still-fresh one; do not replay hours of purchases. Default schedule freshness is one interval with a maximum of five minutes. Accepted runs keep recorded context. External market context must be refreshed before a later financial action if it is stale.

Chain event ingestion stores a finalized cursor and backfills after disconnect in bounded block ranges. Provisional events may update a separate UI view; they cannot credit balances or trigger v1 financial execution. Provider events carry timestamp/sequence or content digest and an explicit freshness bound. Source ordering and receipt ordering are never conflated.

## Execution interface

Runtime starts with an immutable manifest, read-only AST, recorded run context and a short-lived capability. It requests read/AI/checkpoint operations through API internal routes and submits intents to an authenticated executor route. Network policy permits only those internal gateways; the runtime cannot reach signing-provider APIs. Gateways derive agent identity from authenticated capabilities, not request-body tenant IDs.

Capability claims: audience, tenant ID, agent ID, deployment ID/generation, mode, allowed connector/read/action IDs, run ID where applicable, expiry and unique token ID. Lifetime at most five minutes; refresh checks current desired state/generation. Financial requests also recheck live DB authorization and revocation, so token lifetime does not delay pause. Credentials are not embedded in logs or downloadable config.

Interpreter checkpoints record node/iteration, lexical bindings, observation/result references and pending intent. Checkpoint completion and next-step job emission are atomic. No runtime filesystem state is authoritative. Replaying an already completed node returns its recorded result.

## Transaction state machine

`proposed → rejected` or `proposed → reserved → prepared → signing → signed → submitted → included → finalized → settled`.

Additional states are `reconciling`, `failed`, and `cancelled`. A timeout after any external signing/send attempt moves to reconciling unless the provider proves no signature/effect exists. `included` is provisional. `failed` is terminal only when effect absence/revert is established and any gas is accounted for. `cancelled` applies only before externally usable authorization exists; cancelling a signed transaction needs nonce-specific resolution, not deleting a record.

1. Authenticate intent and current generation/mode. Compute a unique logical key from run/node/iteration. Resolve the node from the approved AST, verify its action/assets/amount rule/slippage and legal iteration path, and confirm the active branch against recorded broker observations/results using the shared pure evaluator. Runtime-submitted values cannot widen that node's authority or manufacture a completed predecessor.
2. Validate connector/action and current policy; acquire per-wallet execution serialization. Atomically reserve balance, fees and notional/action quotas.
3. Re-read balances, allowance and reference data; resolve amount, quote and minimum output; pin route and calldata hash.
4. Allocate nonce from durable wallet state plus canonical chain reconciliation. A unique `(wallet, chain, nonce)` slot has one logical action owner; fee-bump attempts share that owner. v1 allows one unresolved nonce per wallet to simplify recovery.
5. If approval is needed, create a child transaction with exact spender/allowance, its own nonce and gas hold. Wait for its finality before fresh-quoting the swap. Allowance grants are not successful swaps. Reject unknown router multicalls and unrestricted permits.
6. Simulate the exact proposed transaction at the freshest supported state. Check decoded calldata, recipient, output minimum and gas again. Simulation is advisory regarding later chain state, not guaranteed inclusion.
7. Recheck desired state/policy immediately before signing. Persist signing-attempt identity. Prefer provider `signTransaction` plus durable signed hash/bytes and application-controlled broadcast when available. Prove required policy coverage and recovery first; otherwise use only a provider send API with proven idempotent request lookup/nonce semantics.
8. Broadcast once; on uncertainty rebroadcast identical signed bytes only while intent remains valid, or reconcile provider request. Never issue a new logical trade because a request timed out.
9. Validate finalized receipt/canonical block and observed effects, settle ledger and quota, release unused holds, and resume or finish the run.

Persist signed bytes encrypted in a privileged store with access limited to the executor. Signed bytes are spend capabilities until consumed/expired, even without a private key. After expiry, inspect chain/nonce state; do not release a reservation solely because quote TTL elapsed. A transaction already signed can still consume gas or execute if its on-chain deadline permits it. A same-nonce replacement/cancellation is an explicit operator procedure with linked attempts and bounded additional gas.

Monad's RPC can report speculative receipts; `pending` is not an authoritative view of the application's in-flight nonce queue. For settlement, require successful receipt where relevant, receipt height ≤ observed finalized height, and matching canonical block hash. On contradictory RPC responses, freeze settlement and query the configured second provider; unresolved disagreement pauses new live execution. [Monad RPC overview](https://docs.monad.xyz/reference/json-rpc/overview)

## Retry matrix

| Operation | Automatic behavior |
| --- | --- |
| Idempotent read/RPC quote | Up to 3 attempts with jittered 1/2/4-second delays within freshness deadline |
| Database serialization/deadlock | Retry entire short transaction at most 3 times; no external calls inside it |
| Cloud provisioning | Retry/reconcile same operation/resource key; inspect tags before launching replacement |
| AI/model call | One dispatched attempt by default; ambiguous charge enters reconciliation |
| Webhook/event delivery | At-least-once; deduplicate source key and verify provenance |
| Signing/broadcast | Reconcile same logical intent/provider key/hash/nonce; never blind new trade |
| Permanent validation/policy rejection | No retry; show reason and await user/config change |
| Settlement transaction | Retry idempotently; keep financial reservations until committed |

Backoff limits are initial values, configurable by operators with observed evidence. They cannot override user's maximum billable calls or create fresh side effects.

## Paper execution

Paper broker shares intent, policy, run and audit contracts with live execution. It uses separate simulation accounts, adapter and credentials, and refuses live wallet IDs. It obtains recorded quote/market observations and applies explicit slippage, fee, liquidity and latency assumptions. Missing data means no fill. It writes a synthetic fill ID and `mode=paper`, never a plausible on-chain transaction hash.

Per-session virtual portfolio initialization is explicit; reset creates a new simulation session with a new history, not an edited ledger. Simulated costs and actual platform-sponsored AI/compute consumption are separate views. Switching to live requires a new funded deployment and review; virtual balances and fills cannot be promoted.

## Isolation and initial limits

Start reference runtime profile at 0.25 vCPU / 0.5 GiB for Fargate if supported by the selected region/platform, then measure before promising capacity. Pin image digest, non-root UID, read-only root, bounded scratch, dropped capabilities, no privileged mode or host mounts, and no application cloud role. Network allows internal brokers only and denies DB, metadata, peer runtimes, arbitrary DNS/HTTP and signer-provider endpoints.

One active run per agent; initial platform admission target 10 concurrent paper agents. Interpreter maxima are authoritative in [language](strategy-language.md). Free quotas are authoritative in [product](product.md). Initial payload/time ceilings: webhook 256 KiB, request body 1 MiB except declared workspace limit, individual observation 64 KiB, model response 64 KiB, read timeout 10 seconds, AI timeout ≤30 seconds. A run may wait durably for chain settlement, but active execution still fits its step/time budget.

## Stop and operations

Pause acceptance atomically sets desired state and invalidates new authorization. Target ≤2 seconds from accepted pause to denial of new operations, measured independently of task termination. Work already signed/broadcast remains visible and reconciled. Stop performs pause plus resource teardown; reconcile financial effects even after compute is gone. Platform kill switch can disable an action, connector, provider, user, or all live signing. Read-only history/withdrawal recovery remains available where safe.

Monitor queue age, worker lease misses, resource leak count, stale observations, pending intents/nonces, reservation age, provider unknown bills, rejection reasons, reconciliation mismatch, and cost-estimate variance. Alert on unknown signed effects and unexplained balances immediately. Publish health without exposing secrets. Store trace IDs, not raw prompts/private reasoning, in default logs.

Before live pilot: restore Postgres to staging, reconstruct pending nonce/ledger state, and run executor in read-only reconciliation mode before enabling signing. Initial operational objectives: RPO ≤5 minutes and RTO ≤60 minutes with managed PITR; measure actual recovery, including provider metadata reconstruction. Money operation loss during restore requires reconciling chain/provider records before any new signing. Backups alone are not a recovery proof.
