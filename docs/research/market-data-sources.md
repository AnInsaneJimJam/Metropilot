# Monad market-data sources

Initial research: **2026-10-12**; implementation probes updated **2026-10-13 UTC**. Current scope is exactly **Aave, Uniswap, and Curve**, with Monad mainnet observations and paper execution. The implementation evidence below supersedes the initial unprobed recommendations. No Envio account is required for the selected direct-RPC path.

## Implemented source and probe evidence

`pnpm market:probe` performs a read-only finalized-block probe using the same adapter and verification logic as ingestion. It checks chain 143, bytecode, token identities/decimals, factory/provider membership and nonzero pool/reserve inventory before accepting native oracle values. Registry addresses are in [registry.ts](../../packages/connectors/src/registry.ts); recorded observations are [contract fixtures](../../packages/contracts/fixtures/priceObservation/valid/).

Probe at **2026-10-13T01:29:42.618Z**, finalized block **112909987**: all four feeds succeeded in **2,382 ms** total, including deployment verification. Uniswap WMON/USDC was `0.024464998059936183`; Curve AUSD/USDC was `0.99974862352118378`; Aave USDC/USD was `0.99985698`, and AUSD/USD was `0.99977044`. These are dated observations, not current quotes or execution guarantees. This duration is a probe measurement, not trigger-to-dispatch latency.

The chosen source uses Monad HTTP finalized reads and WSS `newHeads` wakeups. Subscription acceptance and both push/watchdog wakeups were observed locally. Heads are hints: each ingestion tick independently obtains `finalized`, validates canonical hashes and scans bounded 100-block log ranges. Quiet-feed heartbeats persist the current finalized head in an independent cache-only lane with a separate advisory lock, including while historical oracle reads stall or fail. Only ordered recovery delivers event blocks and range-end checkpoints to triggers; the durable backfill cursor advances only through processed ranges. A recovery outage can delay triggers, and stale observations remain refused. Old/out-of-order observations cannot fire fresh crossings. Changed finalized hashes fail closed. Restart/crash/replay checks use real PostgreSQL and recorded protocol log fixtures.

Uniswap uses its native 30-second geometric TWAP. Curve uses the selected pool’s native EMA (`ma_exp_time=866`), with inversion to AUSD/USDC. Aave uses its native USD reference oracle plus exact RAY supply/variable-borrow reserve rates. Aave adapters reviewed here revert on `latestRoundData`; underlying price-update freshness is unavailable and explicitly labelled. Sources: [Aave Monad address book](https://raw.githubusercontent.com/aave-dao/aave-address-book/main/src/AaveV3Monad.sol), [Aave oracles](https://aave.com/docs/aave-v3/smart-contracts/oracles), [data provider implementation](https://raw.githubusercontent.com/aave/aave-v3-origin/main/src/contracts/helpers/AaveProtocolDataProvider.sol).

The running stack emits observation/read/persistence/fan-out timings and correlated runtime `run.stage` records through first dispatch. Recorded-price threshold-sale replays exercise this path without a CI network dependency; their replay clock is explicit and their durations are not mainnet latency claims. End-to-end production latency percentiles, provider failover and rate-limit/load guarantees remain unmeasured. Synthetic feeds are disabled in the running stack; fixtures remain for tests.

Local fresh-heartbeat sample on 2026-10-13 UTC (35–36 observations per feed; historical replay observations excluded): block-to-receipt age was 2,172–4,643 ms across the four feeds; native oracle-read duration was 192–836 ms. This is a small local sample during catch-up, not a percentile, SLA, finality measurement or end-to-end trigger latency claim. Historical replay age is separately logged and may be hours.

### Ingestion diagnostics and recovery

Failures emit `market.ingestion.failed` with `phase` (`refresh` or `recovery`), `feedRef` and an application-owned `code`. Provider messages, URLs, response bodies and arbitrary provider error codes are excluded. `FINALIZED_CURSOR_CHANGED`, `NONCANONICAL_LOG` and `FINALIZED_HEAD_CHANGED` require canonical-source investigation; disputed recovery ranges are not skipped. `ORACLE_RESULT_CONFLICT` requires adapter/provider investigation without overwriting immutable observations. `LOG_BATCH_LIMIT` identifies a range needing a smaller batch. Unclassified source/storage failures use `SOURCE_OR_STORAGE_FAILURE`; inspect provider availability and database health without exposing credentials.

Regression evidence 2026-10-13: a blocked historical oracle read is kept pending while two subsequent finalized head observations reach the cache without changing trigger state; its later failure leaves the historical cursor unchanged. Separate tests verify distinguishable cursor, batch-limit and contradictory-oracle codes and exclusion of a secret-like provider URL.

## Initial research (before deployment probes)

## Recommendation and boundaries

**Conditional recommendation:** evaluate Envio HyperSync for shared historical ingestion/backfill, alongside ordinary Monad RPC for finalized state reads. Prefer direct Monad WebSocket ingestion if a selected provider reliably exposes finalized commitment updates and backfill stays bounded; prefer HyperIndex if broad pool coverage makes managed indexing/reorg recovery materially simpler. Neither option has demonstrated lower latency for our selected pools yet. An Envio account is useful for the comparison, but documentation alone does not establish it as the better live source.

Keep provider transport independent of protocol adapters. Use venue/version/pool/token identity in each observation; a token pair alone cannot distinguish Uniswap from Curve. Reject stale/missing data instead of substituting synthetic prices. Deterministic fixtures for tests remain a separate concern from a synthetic product feed.

The repository currently specifies finalized 30-second pool TWAPs (D27), push-first ingestion plus quiet-feed heartbeats (D32), per-stage latency evidence (D34), and API-owned scheduling. Curve's native EMA is **not** the same price calculation. The later user decision selected labelled native Curve EMA; D42 records that choice.

## Envio: available, but finality remains our responsibility

HyperSync explicitly lists **Monad mainnet 143** at `https://monad.hypersync.xyz` and **Monad testnet 10143** at `https://monad-testnet.hypersync.xyz`, with separate HyperRPC endpoints. These are current support listings, not successful account/network probes. [Supported networks](https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks)

Local HyperSync and HyperIndex require an API token created through an Envio account; requests without a token receive HTTP 401. Envio Cloud indexers have their own HyperSync access. Personal accounts have one free token, and token product entitlement can differ between HyperSync and HyperRPC. [API tokens](https://docs.envio.dev/docs/HyperSync/api-tokens)

HyperIndex documents automatic canonical-data rollback, atomic blocks/log retrieval through HyperSync, and configurable `max_reorg_depth`. Crucially, calls to external APIs/services are **not rolled back**. Raw HyperSync consumers must implement rollback-guard recovery themselves. Therefore, inference for this project: never call irreversible runtime trigger fan-out from a speculative indexer handler; maintain finalized acceptance and durable application deduplication separately. Rollback support is not a promise of finalized-only delivery or exactly-once trigger delivery. [Reorg support](https://docs.envio.dev/docs/HyperIndex/reorgs-support)

The current HyperSync pricing page lists a $0 development package with fair-use rate limiting, $70/month Starter, and $480/month Pro at monthly billing. Hosting is a different product; no account entitlement or total operating cost was verified. [HyperSync pricing](https://envio.dev/pricing/hypersync)

HyperSync offers client streaming/query tuning, but the reviewed documentation does not establish an authenticated, finalized-only webhook or WebSocket delivery contract for this app. Do not relabel a query stream as provider push without a transport probe. Likewise, log availability does not establish arbitrary historical `eth_call` availability. State-dependent oracle reads need an ordinary RPC endpoint whose history, limits, and block consistency are probed. [Stream configuration](https://docs.envio.dev/docs/HyperSync/stream-config-tuning), [HyperSync overview](https://docs.envio.dev/docs/HyperSync/overview)

## Direct Monad RPC

Monad distinguishes `latest`/Proposed, `safe`/Voted, and `finalized`/Finalized. Standard `logs` subscriptions fire at Proposed. Monad-specific `monadLogs` and `monadNewHeads` emit commitment updates including `commitState` and `blockId`; a proposal can be superseded without an explicit abandonment event. Public providers impose small `eth_getLogs` ranges (100 or 1,000 blocks in the published table). This supports a candidate design of subscription hints plus finalized-height/hash validation and bounded `eth_getLogs` recovery, but actual endpoint support, disconnect behavior, historical state retention, and lag remain untested. [Monad JSON-RPC overview](https://docs.monad.xyz/reference/json-rpc/overview)

## Protocol coverage requires different adapters

### Uniswap

Official Monad mainnet documentation lists v3 factory `0x204faca1764b154221e35c0d20abb3c525710498` and WMON `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`. The factory's `getPool(tokenA, tokenB, fee)` discovers a particular v3 pool; presence of a factory does not prove pool existence or liquidity. [Monad v3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments)

v3's oracle uses cumulative ticks to calculate a geometric time-weighted mean. Its usable history depends on observation cardinality and actual observations, so a proposed 30-second read must be checked on the selected pool. [v3 price oracles](https://developers.uniswap.org/docs/protocols/v3/concepts/price-oracles)

v4 is also officially deployed on Monad 143, with PoolManager `0x188d586ddcf52439676ca21a244753fa19f9ea8e`. v4 uses singleton pool management and hooks; it cannot be covered by a v3 factory/pool-address adapter. “Fully Uniswap” must explicitly choose versions and hook coverage rather than accidentally advertising universal support. [v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), [v4 versus v3](https://developers.uniswap.org/docs/protocols/v4/concepts/v4-vs-v3)

### Curve

Curve's November 24, 2025 announcement confirms Monad Stableswap/Cryptoswap deployment and names three then-live pools. That is launch evidence, not current liquidity evidence. [Monad launch](https://news.curve.finance/curve-live-on-monad/)

The current official deployment directory lists Monad MetaRegistry `0xe6dA14500f0b5783E2325F9C5a7eE5d99DA0fB42`, Stableswap factory `0x8271e06E5887FE5ba05234f5315c19f3Ec90E8aD`, Twocrypto factory `0xe7FBd704B938cB8fe26313C3464D4b7B7348c88C`, and Tricrypto factory `0x6E28493348446503db04A49621d8e6C9A40015FB`. The directory itself warns some entries can be outdated/incorrect; bytecode and actual factory/registry results are required before enablement. No Curve testnet deployment was independently established. [Contract deployments](https://docs.curve.finance/developer/deployments)

Curve adapters must distinguish plain/metapools, underlying token indices, and Stable/Twocrypto/Tricrypto families. Stableswap-NG discovery exposes `pool_list`, coin metadata, and implementation address; quotes use coin indices and `get_dy`. Native `price_oracle` is an EMA with pool-specific smoothing, not a fixed 30-second TWAP. Liquidity operations can update prices/oracles as well as swaps, so swap-only wakeups can miss state changes. [Stableswap-NG integration](https://docs.curve.finance/developer/integration/stableswap-ng/)

For example, StableSwap-NG emits `TokenExchange` with buyer, sold/bought indices and token amounts; this is not Uniswap's `Swap` event and does not directly contain the full oracle state. Read the selected implementation ABI rather than applying one decoder to every Curve family. [Plain pool event source](https://docs.curve.finance/developer/amm/stableswap-ng/pools/plainpool/)

Curve documents native EMA direction relative to coin zero and an implementation-specific historical oracle bug involving token precision/external rates. Pin and inspect the selected implementation; do not generalize an oracle getter's availability into trusted pricing evidence. [Stableswap-NG oracles](https://docs.curve.finance/developer/amm/stableswap-ng/pools/oracles/)

## Original verification questions and resolution

1. Resolved: selected Uniswap v3, Curve StableSwap-NG and Aave v3, with the exact markets in the registry. Broader protocol families/actions are deferred.
2. Mainnet only; testnet remains disabled.
3. Factory/provider identity, token order/decimals, positive inventory and oracle availability were verified by finalized RPC reads. USDC/AUSD quote units remain distinct from USD.
4. Resolved: Uniswap geometric TWAP, Curve native EMA, Aave reference oracle; all are labelled individually.
5. Envio is deferred; no account or token was created. No authenticated Envio performance comparison is claimed.
6. HTTP finalized/history and WSS new-head wakeups work for the chosen public endpoint. Bounded replay/crash/recovery is tested; managed-provider quotas, failover and broad historical retention remain separate operational evidence.

## Discovery endpoints for the implementation probe

The official RPC overview identifies HTTP endpoints `https://rpc.monad.xyz` (QuickNode), `https://rpc1.monad.xyz` (Alchemy), `https://rpc3.monad.xyz` (Ankr), and `https://rpc-mainnet.monadinfra.com` (Monad Foundation). The subsequent implementation used the official network-information WSS endpoint and observed subscription acceptance; the initial rendering alone had not established it. That page identifies Goldsky Edge and Monad Foundation as supporting historical state lookups. [RPC overview](https://docs.monad.xyz/reference/json-rpc/overview), [mainnet network information](https://docs.monad.xyz/developer-essentials/network-information)

Curve API OpenAPI documents `https://api.curve.finance/v1/getPlatforms`, `/getPools/{blockchainId}/{registryId}`, `/getPools/all/{blockchainId}`, and `/getPoolList/{blockchainId}`. However, its retrieved blockchain enum **omits Monad**, despite official deployment evidence above. Candidate `/getPools/all/monad` and `/getPools/monad/factory-stable-ng` therefore require a direct probe, not a claim of documented Monad support. On-chain factory discovery is independently documented. The subsequent implementation verified selected pool/token identities on-chain; these API discovery candidates were not required. [Curve API OpenAPI](https://api.curve.finance/v1/openapi.json)
