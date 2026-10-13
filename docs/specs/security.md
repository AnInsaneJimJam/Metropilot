# Security and guardrail specification

Version: 1.0 design baseline. Owner: funds/security and operations roles. These controls are required behavior, not implemented assurances.

## Assets and threat model

Protect customer balances, signing authority, platform API/cloud credits, tenant strategies/history, provider credentials, and truthful audit records. Treat users, imported configurations, model outputs, token metadata, MCP/tool descriptions, webhook payloads, remote data, and compromised runtime processes as potentially adversarial. Trusted code can still have bugs; independent controls cover the path to money movement.

| Threat | Primary control | Acceptance proof |
| --- | --- | --- |
| Prompt injection asks to drain wallet | Model cannot sign; schema output + deterministic policy + exact transaction decoding | Malicious tool data cannot change recipient, amount cap, or tool catalog |
| Concurrent spend exceeds budget | Atomic reservation and per-wallet serialized execution | Two overlapping requests cannot spend the same available amount |
| Runtime escape/secret theft | Isolated task, least privilege, internal-only egress, no keys/DB role | Access attempts to peers, metadata, signer and secret stores fail |
| Cross-tenant API access | Server-derived identity and tenant-scoped authorization on every object | User A cannot read/write/stream user B's IDs |
| Forged/replayed event | Provider signature rules + dedup + canonical chain verification | Invalid signature/replayed event produces no new run or deposit |
| Retried trade duplicates funds movement | Durable intent/nonce/provider identity and finality reconciliation | Crash after send results in one logical effect |
| Wallet provider or operator credential compromise | Provider allowlists, separate policy admin, per-agent wallet, operator controls | Raw signing/unknown chains/recipients/export are denied |
| Free-tier abuse or runaway model | Admission caps, user/global quotas, bounded completion, prepaid holds | Quota boundary stops new work without charging another bucket |

## Identity and authorization

Use verified provider authentication; API validates issuer, audience, signature, expiry and session state using the chosen SDK. Browser has no authority simply because it passes an owner ID. Prefer secure, HTTP-only, same-site application sessions; protect cookie-authenticated mutations against CSRF and enforce allowed origins. Rate-limit login, configuration imports, launches, webhooks and model access independently.

Implemented for the hosted API ([D56](../decisions.md)): Privy access tokens are verified with the pinned ES256 algorithm against the configured app key (issuer, audience, subject, expiry, issued-at and not-before checked); the app session is an opaque `__Host-` cookie whose SHA-256 alone is stored, expires after 8 hours and is revoked on sign-out; a suspended tenant cannot sign in and loses open sessions. Hosted mutations require the configured HTTPS `Origin`. Sign-in has a separate per-process 10/min per-IP bucket; a shared ingress limiter and trusted-proxy client addresses remain for hosting. Step-up authentication is not implemented.

Roles for MVP: account owner, restricted internal runtime, control-plane worker, executor, and audited platform operator. Product accounts are single-owner; team collaboration in this repository does not imply a product organization/RBAC feature. Step-up authentication covers live activation, limit increases, withdrawals, destination changes and account recovery. Login recovery must not silently bypass wallet authorization controls.

Every tenant-owned table carries tenant ID, with composite foreign keys preventing cross-tenant attachment. API checks scope explicitly. Use non-owner DB roles and tested RLS for tenant query routes where configured; RLS bypass by owners/superusers must be tested, not assumed away. Runtime has no DB role. Executor only accesses records needed for authorized financial operations. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

## Deterministic policy checklist

For each intent, enforce tenant/wallet ownership; active deployment generation; live/paper mode; current desired state; matching approved AST node/iteration and branch evidence; selected connector/version/action; exact chain and accepted token; reviewed contract/selector/router commands; intended recipient; available bucket; minimum native reserve; amount, per-run/daily notional and count limits; fresh quote/reference price; maximum slippage/price impact; max fee/gas; bounded approval/permit; simulation result; and user consent/policy version.

Limits combine by taking the **most restrictive** platform, user, connector and strategy setting. Missing required inputs or valuations deny the action. A daily notional cap uses a stored conservative price at authorization and includes pending holds; valuation staleness is a stop condition. Advanced users may lower platform limits and configure within published ceilings, never remove them.

Initial live-demo default policy: spot exact-input actions only, one unresolved nonce per wallet, one trade intent per run unless explicitly reviewed, maximum slippage 50 bps rookie / 100 bps platform ceiling, daily action count 24, and user-set per-trade/daily value caps required. Fee/gas ceilings and approved pairs are configured from actual chain tests, not fabricated constants in this scaffold. Observe reference price deviation with a per-market published bound; unsupported reference data blocks live trading for that pair.

Loss controls can pause after a measured, cashflow-adjusted drawdown using finalized inventory and fresh prices. They are later monitoring controls unless implemented and tested; neither stop-loss nor pause guarantees a maximum market loss. Do not advertise an unimplemented drawdown guard as part of the initial hard spend limits.

## Wallet and signing controls

Separate normal signing credentials from wallet-policy administration and platform owner recovery credentials. Runtime and API worker never receive them. Executor constructs transactions from typed intents; it has no generic user-callable `sign(bytes)` endpoint. Deny arbitrary message/typed-data signing, key export, unknown chain IDs, unchecked multicalls, token approvals to unknown spenders, and infinite allowances. Decode every nested router command actually supported.

Provider policy capability is a pre-live probe: chain and receiver restrictions must work on the chosen signing method, not just on a different SDK path. Provider counters are a secondary blast-radius control; accounting holds remain authoritative. If correct policy enforcement cannot be demonstrated, live mode stays disabled. Rotation revokes old credentials and proves prior signer requests fail.

A compromised privileged executor is a materially stronger threat than a malicious model. Mitigate with narrow provider rules, separate policy administration, small per-agent deposits/demo limits, audited releases and restricted operator access. Do not claim the model sandbox removes platform custody risk.

## AI and connector data

Keep system instructions and external data separated. Tools come from reviewed catalog bundles with pinned versions; remote text cannot register tools or replace skills. User prompts are bounded data. Model outputs must match the chosen schema, unit limits and enum choices. Rejection/refusal/timeout halts the relevant run; no uncapped repair loop. Store a concise explanation and evidence references, not hidden reasoning.

Hosted connector selection accepts catalog IDs, not arbitrary URLs or commands. Block SSRF to loopback, RFC1918/private, link-local and metadata destinations including IPv6, redirects and DNS changes. Provider webhooks use their published raw-body verification procedure, timestamp window, replay prevention and key rotation. Public endpoints have bounded payloads and rate limits.

For future remote MCP, use the negotiated protocol's maintained SDK/auth flow; validate token audience and resource, avoid token passthrough, treat sessions as transport state rather than identity, and validate both tool arguments and outputs. Local stdio connector distribution keeps operator credentials local. [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

## Privacy, retention and supply chain

Secrets live in the selected cloud secret manager with per-process access. Configuration contains secret references only, redacted from user export where platform-owned. Log scrubbing removes bearer tokens, API keys, signed transactions, raw private prompts and personal account data. Encrypt backups and privileged artifacts; TLS on external and internal authenticated routes.

Initial retention: operational logs 14 days; raw redacted observation/model payloads 7 days; run/decision summaries 30 days for paper sessions. Keep ledger/transaction/custody audit records durably for reconciliation and later legally determined retention; public launch must set the applicable retention/deletion policy. User deletion tombstones access and removes dispensable content, not money records required to reconcile outstanding funds.

Implemented 2026-10-13 (D57): the audit stream is pruned by the scheduled `pnpm db:prune` (`AUDIT_RETENTION_DAYS`, default 30) through `prune_audit_events`, the only delete path past the immutability trigger; intent-linked, reservation, transaction, ledger and policy-denial events are never pruned. Operational logs, observation/model payloads and run summaries have no pruning job yet.

Pin dependency versions and container digests, review connector manifests/ABIs, scan dependencies and images, and restrict deploy permissions. Never download/execute runtime packages supplied by a user or model. Research URLs and model-generated text are evidence/data, not instructions to the coding agent.

## Incident and release controls

Operational response: disable new signatures/paid dispatch → preserve pending holds and evidence → revoke compromised runtime/signer tokens → reconcile chain/provider state → notify affected users through an approved operational process → recover with a reviewed change. Do not delete disputed records, automatically sweep customer assets, or claim pending transactions are cancelled.

Public custody requires tested withdrawal/recovery, accountable on-call/treasury roles, explicit terms and jurisdiction review, audited access and restore drills. Team-fund hackathon demonstration stays capped and labeled. The root checklist separates these releases so a working demo does not imply public-custody readiness.
