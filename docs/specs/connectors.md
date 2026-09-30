# Connector specification

Version: `connector/1`. Owner: `packages/connectors`. A connector checkbox selects a reviewed **capability bundle**, not unlimited protocol knowledge or control.

## Bundle contents

Each versioned bundle contains a manifest; supported network/token/contract registry references; typed read and action schemas; observation/event normalization; transaction builder/decoder for supported actions; user-facing capability description; short agent instructions; and paper/live conformance fixtures. MCP is a distribution interface over these capabilities. Webhooks are an ingestion transport where a provider actually supplies them; otherwise use RPC subscriptions/polling/backfill.

Manifest fields: `schemaVersion`, catalog ID, semantic version, content hash, maintainer role, supported modes/networks, capabilities with input/output schema refs, protocol/ABI versions, exact deployment-address sources and verification date, data sources/freshness rules, required credentials by reference, cost category/rate reference, tool permissions, known limitations, and disabled reason. Credentials and arbitrary startup commands never appear in published manifests.

Capabilities have stable IDs such as `price.read`, `balance.read`, `swap.quote`, `swap.exactInput`, and protocol-specific event types. Read, paid read, and financial action are separate classes. Selecting a read does not grant swap access. Parent selection can propose a default capability set, but launch review lists its actual authority.

## Initial Uniswap scope

Implement one verified Monad spot pair and exact-input swap path first. Choose a documented router/protocol version whose calldata can be completely decoded and constrained; direct v3 single-hop is the default narrow route if the chosen pair has a supported pool. Using Trading API routing is an alternate implementation path only after proving all returned commands/approvals can be validated against the same policy. Uniswap's mainnet announcement and deployment registry support availability, not every possible pair or testnet route. [Monad deployment evidence](../research/sponsors.md)

No implicit UniswapX orders, permit variants, arbitrary Universal Router commands, multihop routes, liquidity positions, fee-on-transfer tokens, or dynamic token discovery in the first capability. Unsupported API routes are rejected, not forwarded to the signer. The selected pair must have usable liquidity, a fresh independent price reference for live policy, known decimals, tested allowance behavior, and a reliable quote path.

Data path: ingest approved pool logs/finalized RPC observations and normalized reference prices; expose immutable provenance. Execution path: executor obtains quote/build output, decodes it, verifies chain/target/spender/tokens/recipient/input/minimum output/deadline/fee cap, simulates, then signs under policy. Connector code never owns a private key or bypasses ledger reservation.

## Interface behavior

| Operation | Inputs | Result and obligations |
| --- | --- | --- |
| Describe capabilities | Pinned catalog version and network | Exact supported set and readiness; no network side effect |
| Read | Capability + typed args + freshness requirement | Typed observation with timestamp/source/block; explicit missing/stale error |
| Backfill events | Approved subscription + finalized cursor/range | Ordered normalized events + resumable cursor; dedup keys stable |
| Quote | Fixed amount/assets, recipient, limits | Route, min-output derivation, fee estimate, expiry and source state |
| Build transaction | Executor-approved frozen quote/intent | Unsigned calldata/value/target and decoded effects; no signing |
| Interpret receipt | Canonical finalized receipt + known intent | Actual asset movements/fees or explicit discrepancy; no optimistic success |

Quotes expire after 15 seconds by default; actual supported provider/pair can require shorter expiry. User maximum slippage is applied to expected output using exact floor arithmetic, producing an on-chain minimum. Validate reference price separately from router quote to avoid accepting a manipulated quote merely because slippage is small. On-chain deadline is short, explicit and inside policy; expired unsigned quotes are refreshed only under the same still-valid intent, without changing its authorized input ceiling.

Polling starts at 15-second cadence per shared market for the hackathon; finalized event subscriptions can reduce latency. Per-agent strategies consume shared observations, not one paid subscription per user. Reference feed age is feed-specific, recorded in the catalog; no hardcoded universal heartbeat. Feed decimals, validity fields, market hours where relevant and deviation bounds must be checked.

## Webhook and RPC rules

Authenticate a webhook using the provider's documented signature over raw bytes and timestamp window. Enforce payload bounds and replay deduplication; rotate keys. Acknowledge only after durable storage. If authenticity cannot be verified, corroborate independently before financial use or disable the source. Provider retry behavior is part of integration evidence.

RPC WebSocket messages are hints. Persist a cursor, backfill bounded ranges after disconnect, and verify canonical finality before accepting chain events. Chain reorg/speculative events cannot create spendable deposits. Use the canonical source key across webhook/RPC paths. A pool price observation is not automatically a USD price; the feed mapping declares units and conversion sources.

## MCP and agent instructions

MCP tools expose the same typed capabilities and structured results, with explicit read/action classification. Hosted mode invokes curated local implementations through brokers; it does not need a remote MCP server per user. Bundle instructions teach correct usage and limits; they cannot grant authority or override system policy. Never claim a bundle is the protocol's official MCP integration unless that provenance is verified.

Connector-only delivery later provides a versioned package and MCP entry point, sanitized configuration, environment-variable references, supported local authentication, and conformance tests. The external operator supplies custody/policy. Model tools that propose trades still need operator authorization; library defaults should be read-only unless an execution capability is explicitly configured. Remote HTTP MCP must implement current negotiated authorization/audience rules through a maintained SDK. [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## Other integrations

| Candidate | Additional design required before enablement |
| --- | --- |
| Kuru | Choose aggregator versus orderbook; deposits/open orders/cancellations add inventory and recovery states |
| Aave | Supply/withdraw receipts, reserve caps/pauses, interest and withdrawal liquidity; borrowing deferred |
| Curve | Verified pool/token indices, quote math and slippage; unsupported pools stay disabled |
| Morpho | Market/vault identity, curator/rate/withdrawal constraints; user “Morpheus” naming remains unresolved |
| Nansen | Endpoint-specific Monad coverage, paid data quota/freshness, optional guarded x402 settlement |
| Chainlink | Exact feed/network, decimals, update timestamp and reference-price rules; oracle is not executable liquidity |
| Agora | Verified token contract/decimals and custody/settlement support; not a cloud billing connector by itself |

Primary deployment/support evidence and sponsor status are in [research](../research/sponsors.md). Mainnet evidence never implies testnet evidence. “DeFi” is a category rather than a specific protocol. Do not populate the live connector list with unchecked boxes that imply working integrations.

## Conformance acceptance

An enabled capability must prove: exact network/address and ABI match, typed args/results, unsupported-operation rejection, empty/stale/malformed data handling, authenticated events or independent verification, duplicate/backfill behavior, bounded paid reads, decoded transaction limits, allowance scope, simulation failure, finalized receipt interpretation, and no embedded secrets. Record verified versions and synthetic/fork/live test distinction. A connector can be paper-only while live proof is pending.
