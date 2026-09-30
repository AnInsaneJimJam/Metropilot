# Curated connectors

Own reviewed manifests, network/contract registries, typed data/action adapters, normalized events, transaction builders/decoders and later library/MCP distribution. Read [connector specification](../../docs/specs/connectors.md), [sponsor research](../../docs/research/sponsors.md), and [security](../../docs/specs/security.md).

Start with one verified Uniswap exact-input route and paper fixtures. Separate read and executor-only exports. Never sign, own wallet keys, forward arbitrary calldata or assume every named protocol has an official MCP/webhook product. Verify chain/address/ABI/pair and capability availability separately for each mode/network. Morpho/Morpheus ambiguity blocks that optional connector only.

## Checklist

- [ ] CNR-1 / G1,G4: define capability manifests, synthetic paper registry and observation schemas.
- [ ] CNR-2 / G4,G8: implement authenticated/deduplicated event ingestion/backfill and bounded reads.
- [ ] CNR-3 / G8: verify one mainnet/test target route, addresses, decimals, liquidity and reference price.
- [ ] CNR-4 / G8: build/decode quote, exact allowance, swap and finalized receipt interpretation.
- [ ] CNR-5 / G8: pass unsupported route, stale source, manipulated calldata and replay conformance checks.
- [ ] CNR-6 / G11: expose sanitized library/MCP distribution with operator-owned keys/policy.
- [ ] CNR-7 / G12: add the next protocol only with a scoped action/risk specification and evidence.

Prerequisite: [contracts](../contracts/AGENTS.md). Execution is [executor](../../apps/executor/AGENTS.md)'s responsibility; ingestion scheduling belongs to API. Tick only after capability tests; sponsor research alone is not integration completion.
