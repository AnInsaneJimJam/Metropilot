# Metropolis sponsors and integration research

Research date: **2026-10-01**. Status: evidence for implementation planning, not a claim that integrations or bounty eligibility have been completed. URLs below are primary product documentation or pages published by event hosts/registration partners. Provider pages are mutable; confirm the selected account, region, model, contract and bounty rules before implementation.

## Recommendation

Build the first demonstration around **Monad + Privy + one model provider + Uniswap**. Add **Chainlink** for a reference-price guard when the chosen pair has a supported feed. Keep **Kuru** as the next trading connector with a strong Monad-specific story. Use **Kimi** as the first AI-provider candidate and **Qwen through Alibaba Cloud Model Studio** as the second. Select one cloud for the first deployment: AWS is a reasonable baseline if the team already has an eligible account; Alibaba Cloud is an alternative if usable sponsor credits arrive in time.

These are project recommendations based on the evidence below, not sponsor requirements. Demonstrate a complete budgeted decision, rejected unsafe action, simulated trade and auditable execution before adding integrations solely to collect logos. A connector checkbox must represent a tested set of capabilities, not a promise of every feature a protocol offers.

## Event evidence and its limits

The [Rise In Metropolis registration page](https://www.risein.com/monad/monad-metropolis-hackathon) names **Agora, Nansen, Chainlink, Privy, Alibaba Cloud and Kimi** as sponsor-bounty participants. Its body gives a September 1–October 13 build window, October 14–27 judging and November 3, 2026 results. Its metadata instead shows August 31, an October 12 deadline and November 2 end date. This inconsistency is unresolved; do not assume a timezone conversion without an authoritative deadline and timezone.

The [London activation page, hosted by Encode Club and Monad Foundation](https://luma.com/metropolis-lon-oct-2026), confirms September 1–October 13 and names **Dynamic, Privy, Perpl, Nansen, Chainlink, Agora, Kuru and MetaMask** among bounty sponsors. It describes the London event as separate from registering for the main hackathon. It also quotes a different overall-winner amount from Rise In. Use neither prize amount as a contractual promise.

The current [Monad event URL](https://www.monad.xyz/developers/hackathons/metropolis) and [main hackathon site](https://hackathon.monad.xyz/) could not be reliably retrieved as current Metropolis rules in this research session: the former failed to load through the research tool and the latter returned an older evm/accathon page. Exact individual bounty requirements, required submission artifacts, combinations permitted, geographic restrictions and credit offers remain **unverified**. Save those rules when the team can access its event portal. No third-party sponsor list is treated as final authority.

Best-fit submission track, as a project recommendation: **Onchain Finance & Trading**; **Trust, Identity & AI Infrastructure** is a secondary fit if the submission emphasizes secure agent execution. Confirm whether the event permits more than one track.

## Sponsor status and product fit

“Listed” means named in an event-host or registration-partner source above. It does not establish that this particular implementation qualifies for a bounty.

| Provider | Event evidence | Useful role | Recommendation and prerequisite |
| --- | --- | --- | --- |
| Monad | Event platform | Settlement and protocol execution | Required chain; configure mainnet and testnet separately. |
| Privy | Listed by both sources | Login, provisioned wallets, constrained server signing | First wallet candidate; prove required Monad signing and policy rules. |
| Kimi / Moonshot AI | Listed by Rise In | Bounded AI analysis blocks | First model candidate; developer API account and pricing required. |
| Alibaba Cloud | Listed by Rise In | Hosting; Qwen via Model Studio | Optional cloud or second model provider; verify credit scope and region. |
| Qwen | No separate sponsor listing verified | Alibaba model family | Treat as a product integration under Alibaba, not a distinct confirmed sponsor. |
| Chainlink | Listed by both sources | Reference prices and stale-price guard | Add for supported assets; do not assume all Chainlink products or feeds exist on both networks. |
| Nansen | Listed by both sources | Wallet/market context, optional paid data | Add after proving endpoint coverage, freshness and cost. |
| Agora | Listed by both sources | AUSD funding/trading asset | Optional approved asset; token support does not provide cloud payment settlement. |
| Kuru | Listed by London hosts | Monad-native trading and market events | Strong second connector, or alternative first connector after contract/API validation. |
| Dynamic | Listed by London hosts | Alternative wallet and authentication provider | Compare with Privy if a concrete feature or eligibility gap appears; do not integrate both initially. |
| Uniswap | No Metropolis sponsor evidence found | Initial spot-swap connector | Verified Monad integration, useful regardless of bounty status. |
| Aave / Curve / Morpho | No Metropolis sponsor evidence found | Later lending or trading connectors | Monad availability has primary evidence below; each needs its own narrowed action set. |
| AWS | No Metropolis sponsor evidence found | Initial hosting option | General credits are separate from hackathon sponsorship. |
| Alchemy | "Best Projects using Alchemy" bounty in the team's event portal (seen 2026-10-14) | Second custody RPC witness; market HTTPS/WSS transport | Integrated (D60): `CUSTODY_RPC_SECONDARY`, `MARKET_RPC_URL`/`MARKET_WS_URL`, `pnpm alchemy:check`. Gas Manager and Webhooks deferred; see below. |

Perpl and MetaMask are also event-listed candidates. Do not expand this spot-only first version into leveraged perpetuals or a second wallet stack merely for a bounty. Their specific product fit and bounty rules need separate research if selected.

## AI providers: Kimi and Qwen

### Kimi / Moonshot AI

The [Kimi API overview](https://www.kimi.ai/help/kimi-api/api-overview) documents an OpenAI-compatible Chat Completions interface, developer API keys, and pay-as-you-go API billing. It distinguishes this service from Kimi Membership and Kimi Code. The model does not automatically have access to blockchain state or external databases; the application must provide context or implement tools. The overview exposes a model list and pricing links: use those at implementation time instead of copying a model identifier from a tutorial.

Project integration contract:

- Keep provider credentials in the trusted model gateway, outside browsers, configuration exports and strategy sandboxes.
- Allowlist an exact model identifier and supported parameters. “Reasoning level” is a product control mapped to documented provider settings; unsupported settings are rejected rather than silently ignored.
- Reserve worst-case allowed token cost before the call. Cap input, output, call count, execution time and retries; settle from returned usage and reconcile unknown charges.
- Require schema-valid output and represent refusal, timeout, malformed output and budget exhaustion as explicit results. The model proposes a bounded decision; it receives no unrestricted signing tool.
- Record the provider/model/configuration and usage necessary for auditing; do not claim access to private model reasoning.

**Bounty gap:** API availability is confirmed; event-specific model choices, credit amounts and proof requirements are not. A personal chat subscription is not assumed to fund platform API calls.

### Qwen / Alibaba Cloud Model Studio

[Model Studio OpenAI compatibility documentation](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), updated September 28, 2026, documents Qwen access through an OpenAI-compatible interface. Keys are region-bound; several regions use workspace-specific endpoints. Select the endpoint from the chosen workspace console and keep provider, region, workspace, model and credential reference together. Do not assume that a key for one region works in another, that all models expose identical features, or that an example model has a free quota.

The older [Assistant API function-calling page](https://www.alibabacloud.com/help/en/model-studio/function-calling) is marked deprecated and directs users toward the Responses API. Do not make that legacy Assistant API the platform's agent harness. The initial gateway can implement only the currently documented request surface needed for structured AI blocks.

**Implementation decision:** use the same bounded model-request contract for both providers, with a small provider-specific parameter mapping. No self-hosted model/GPU cluster is required for the first version. Hosting on Alibaba does not imply a particular Qwen model, model-region availability, API quota or bounty eligibility.

## Wallet providers and custody

[Monad's embedded-wallet directory](https://docs.monad.xyz/tooling-and-infra/wallet-infra/embedded-wallets) lists Privy and Dynamic among its infrastructure options. This is chain-specific evidence beyond generic EVM compatibility. It does not prove every smart-wallet, gas-sponsorship or policy feature is available on every network or account tier.

[Privy's policies documentation](https://docs.privy.io/controls/policies/overview) describes network and contract restrictions, transfer rules, time-limited signers and calldata/typed-data constraints. Deny rules take precedence; unmatched methods/actions are denied when policies apply. Numeric policy fields use the supplied smallest-unit values. These controls are useful for a signer boundary, but the application must still implement aggregate budgets, concurrency-safe reservations, quote validation and transaction reconciliation.

[Privy's agent-wallet product page](https://www.privy.io/agent-wallets) describes developer-owned and user-owned authorization models and integration with custom agent runtimes. Choose the ownership model explicitly: for this project's requested custodial experience, platform-controlled signing must be documented honestly. Do not describe it as self-custody merely because the key material is managed by a wallet provider. Keep tenant wallets separate; the three budget categories are accounting and authorization rules, not three private keys handed to the AI.

[Dynamic's chain configuration documentation](https://docs.dynamic.xyz/chains/enabling-chains) supports EVM networks and custom RPC configuration. Use it as an alternative if a concrete requirement is better served; verify delegated/server-wallet permissions and exact signing APIs before switching. Supporting ordinary EVM signing does not automatically establish identical smart-account or policy capabilities.

**Acceptance evidence before live funding:** two test tenants; wrong-tenant access rejected; wrong-chain, wrong-contract and oversized transactions rejected; expired/revoked signer rejected; arbitrary typed-data signing rejected; wallet-provider outage fails closed. Product claims about safety must match these observed controls.

## Trading connector availability

| Protocol | Verified primary evidence | Narrow first capability | Remaining proof before enabling |
| --- | --- | --- | --- |
| Uniswap | [Monad launch announcement](https://blog.uniswap.org/monad-mainnet-is-now-live-on-uniswap), November 24, 2025, confirms Protocol and Trading API support; [v3 Monad deployment documentation](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments) lists chain-specific contracts. | Exact-input spot quote/swap, receipt and pool-event observation. | Pin selected protocol/router version and deployment; verify token pair, liquidity, API access if used, allowance path, slippage, deadline and decoded calldata. Testnet is a separate target, not inferred from mainnet. |
| Kuru | [Official overview](https://docs.kuru.io/) identifies its onchain orderbook/aggregator on Monad; [contract registry](https://docs.kuru.io/contracts/Contract-addresses) separates mainnet/testnet; [integration guide](https://docs.kuru.io/contracts/Integration) covers tracking markets and trades. | Spot swap or a constrained order action plus market/trade events. | Decide Flow aggregator versus direct orderbook route; verify selected API/key access and exact contracts. If using orderbook deposits, model funds held in the protocol and outstanding orders. |
| Aave | [Aave Labs July 2026 development update](https://governance.aave.com/t/al-development-update-july-2026/25482), published August 14, states V3 launched on Monad; [Aave's Monad market](https://app.aave.com/?marketName=proto_monad_v3) is present. | Later supply/withdraw for an approved reserve. | Pin pool/reserve addresses and current pause/cap state. Lending and borrowing need additional risk rules; borrowing is outside the spot-trading first version. |
| Curve | [Curve's November 24, 2025 announcement](https://news.curve.finance/curve-live-on-monad/) confirms Monad Stableswap/Cryptoswap deployment and frontend integration. | Later swap against one approved pool. | Verify current registry, pool contracts, token indices and liquidity; a launch announcement is not a current quote or universal router allowlist. |
| Morpho | [Official November 2025 roundup](https://morpho.org/blog/morpho-effect-november-2025) says Morpho is live on Monad; [official network data](https://data.morpho.org/) includes Monad. | Later supply/withdraw for a reviewed market or vault. | Pin market/vault version, addresses, curator dependencies and withdrawal liquidity. The readable [address page](https://docs.morpho.org/developers/contracts/addresses/) did not expose clear Monad labels in this retrieval; resolve against official source/registry and chain before enabling. |

The user's “Morpheus” may mean Morpho, but that name is not silently resolved: **Morpho is the researched lending protocol; a different Morpheus product needs its own specification.** “DeFi” is a category, not a connector implementation.

No research here proves that every protocol ships an official complete MCP server or a managed webhook product. Our connector bundle is an application-maintained combination of validated actions, event adapters, schemas and agent instructions. It may expose those actions through MCP; it may use RPC logs/polling where no trusted webhook provider exists. Label capability and provenance accurately.

## RPC provider: Alchemy

Checked 2026-10-14. [Alchemy's Monad page](https://www.alchemy.com/monad) lists three supported products: the Node RPC
API, Gas Manager and Webhooks. Monad's [network information](https://docs.monad.xyz/developer-essentials/network-information)
lists `rpc1.monad.xyz` as Alchemy-run (15 rps, `debug_`/`trace_` disabled) and `rpc.monad.xyz` as QuickNode-run, so an
Alchemy app key gives a second, independent operator. Our app's endpoints (`monad-testnet.g.alchemy.com`,
`monad-mainnet.g.alchemy.com`) served chain 10143 and 143, finalized blocks, receipts, historical `eth_getBalance`/`eth_call`
and WSS `newHeads`; evidence under E06 in [decisions](../decisions.md). Free-tier limits seen: `eth_getLogs` at most
10 blocks per request, HTTP 429 at about 20 requests/s.

- **Node RPC API: used.** Second witness for custody finality, receipts and balances, and market transport (D60).
- **Gas Manager: deferred.** It sponsors gas for ERC-4337 smart accounts; custody uses Privy server-wallet EOAs (D48),
  so it would need a new wallet stack.
- **Webhooks (Address Activity): deferred.** It could only wake the deposit scanner early, never credit, and the
  scanner already polls every 2 s. It needs a public HTTPS route with signature verification. Monad support is listed
  on the product page but was not checked in the dashboard.

## Data, prices and stablecoins

### Chainlink

Chainlink's [ETH/USD feed page on Monad mainnet](https://data.chain.link/feeds/monad/monad/eth-usd) provides chain-specific evidence; its [May 2025 changelog](https://dev.chain.link/changelog/data-feeds-on-monad-testnet) confirms Data Feeds availability on Monad testnet. This does not guarantee that a chosen asset pair is covered on both. [Data Feeds documentation](https://docs.chain.link/data-feeds/overview) distinguishes feed product types.

Recommended use: independent reference-price checks with a configured maximum age, correct decimals and fail-closed missing/invalid data behavior. A feed is not an executable DEX quote. Do not add CCIP, Automation, Data Streams or CRE unless the selected use case needs them and their exact network/product support is verified. Bounty rules may require something more than reading a price feed.

### Nansen

[Nansen's chain reference](https://docs.nansen.ai/reference/chains) lists Monad but warns that coverage varies by endpoint. The [current wallet-balances endpoint schema](https://docs.nansen.ai/api/profiler/address-current-balances) explicitly includes `monad`. Use an endpoint-level capability check; a chain listed at platform level does not establish that every Smart Money, P&L, historical or alert query works there.

[Agentic-payments documentation](https://docs.nansen.ai/getting-started/agentic-payments) describes x402 payment in USDC on Monad, Base or Solana for supported endpoints, with exceptions requiring accounts/API keys. This could demonstrate real crypto-paid data access. Before payment, validate the server, quoted amount, asset, network, recipient, authorization lifetime and retry behavior against policy. Do not let an untrusted 402 response dictate arbitrary payments. This optional path is distinct from the baseline API-key integration and needs ledger support for onchain API debits.

Suggested first use: read-only context on one approved wallet or token, with source time and paid-call metering. Nansen valuations are supplementary analytics, not the authoritative custody balance or settlement record.

### Agora / AUSD

[Agora's contract-deployment registry](https://docs.agora.finance/developer/contract-deployments) lists both Monad mainnet and testnet AUSD. Treat each `(chainId, tokenAddress)` as a separate asset; never recognize a deposit by symbol alone. Before live use, verify decimals and deployed bytecode on the chosen chain. Issuer mint/redeem access and commercial settlement arrangements are separate from permissionless ERC-20 transfers.

Recommended optional integration: an approved stablecoin deposit/trading asset if liquidity and event requirements justify it. AUSD support does not mean AWS, Kimi or Alibaba can be paid automatically from AUSD. Do not automatically invest operational reserves in yield products.

## Hosting and free sandbox economics

[AWS Free Tier](https://aws.amazon.com/free/) describes up to $200 for eligible new customers: $100 initially and up to $100 earned, with a free plan lasting up to six months or until credits are exhausted. Paid accounts can incur charges beyond available credits. The [FAQ](https://aws.amazon.com/free/free-tier-faqs/) documents eligibility and credit expiry; the actual account dashboard governs remaining credits. This is not an unlimited production-hosting commitment or a reason to create repeated accounts.

[Alibaba's AI Catalyst program](https://www.alibabacloud.com/en/startup/ai) advertises potential model-token/cloud-credit support subject to application and review. The retrieved [Startup Cloud Credits terms](https://www.alibabacloud.com/en/startup/terms-and-conditions) show a campaign ending March 31, 2026 and restrict transfer of credits to end customers. Those older terms cannot establish a current October entitlement. Obtain the exact hackathon offer and eligible services before selecting infrastructure on the assumption of free usage.

Project recommendation: retain AWS as a documented first-deployment baseline if access is already available; choose Alibaba instead only when usable credits, region, deployment support and team familiarity justify it. Do not implement simultaneous multi-cloud orchestration in the first release. Cloud provider selection is an infrastructure configuration decision; user deployments should remain the same versioned application contract.

“Free sandbox” means the platform subsidizes a bounded allowance. Publish session/runtime, CPU/memory, model-token and concurrency limits; stop or pause at the allowance and show the state honestly. Paper balances are not onchain deposits, and simulated profits are not withdrawable. Process isolation and paper trading are distinct requirements: even an agent with virtual money must be isolated from other tenants and platform credentials.

## One-wallet billing: what the sponsors do not solve automatically

The one-wallet promise is feasible as a product abstraction, but ordinary cloud and model accounts have their own billing systems. The researched sources do not establish direct wallet billing for AWS, Kimi or Qwen. An onchain API-payment option such as Nansen's does not generalize to every vendor.

Recommended baseline flow:

1. Credit a tenant only after an accepted asset deposit meets the chain confirmation policy.
2. Allocate funds to operational and trading ledger accounts with explicit permissions; never let the agent move the allocation boundary itself.
3. Reserve estimated permitted cost before each paid model/compute action; record actual usage and settle/release reservations.
4. The platform pays vendor invoices from its operational treasury/provider account; separately reconcile the customer's recorded usage and disclosed conversion/fee terms.
5. Treat provider outages, unknown usage, delayed invoices, stablecoin conversion, taxes/fees and refunds as explicit accounting states. Credits reduce platform costs; they are not customer cash.

This is an architecture recommendation, not legal or accounting advice. Actual custody and paid public operation require the project's release review; sponsor participation does not remove those obligations.

## Integration completion checklist

These research-follow-up items remain unchecked because no integration or commercial account was created in this documentation task. Tick only with linked evidence.

- [ ] Capture current event deadline/timezone, registration status and chosen track rules from the team's portal.
- [ ] Capture exact bounty requirements for the integrations actually being claimed.
- [ ] Confirm credentials, permitted use, regions, quotas and credit expiry for selected vendors.
- [ ] Pin chain/network, verified deployment addresses, ABI/version and token identities in the connector registry.
- [ ] Demonstrate each enabled connector's narrow action/event set, unsupported-operation rejection and failure behavior.
- [ ] Demonstrate signer-side restrictions and application budget enforcement independently.
- [ ] Measure model and hosting usage; show estimated operating runtime without promising profit or maximum capital lifetime.
- [ ] Record mainnet, testnet, fork and paper capabilities separately; do not substitute one for another in the demo claim.
- [ ] Resolve Morpho/Morpheus naming before implementing that optional connector.
- [ ] Recheck source pages and pricing immediately before implementation and submission.

No API calls using paid credentials, real transactions, deployments, registrations, credit applications or external messages were performed for this research.
