# Decision register

Baseline: 2026-10-01. These engineering decisions are made for the requested scaffold. External account, legal, network and bounty facts remain verification gates; no document claims they have passed.

## Settled choices

| ID | Decision | Reason / consequence | Authoritative detail |
| --- | --- | --- | --- |
| D01 | pnpm/TypeScript monorepo with five app roots | One team shares contracts; docs build is separate, runtime/signer isolation is explicit | [Architecture](../architecture.md) |
| D02 | Modular control plane + Postgres jobs/outbox | Transactions and durable state without a distributed workflow stack | [Runtime](specs/runtime.md) |
| D03 | Blockly JSON workspace → typed JSON AST | Native recommended format, deterministic server semantics, no arbitrary code | [Language](specs/strategy-language.md) |
| D04 | Custodial per-agent wallets and three ledger buckets | Matches latest user instruction; operating and trading authority stay distinct | [Funds](specs/funds-and-budgets.md) |
| D05 | Runtime never signs; executor authorizes/builds/reconciles | Model text cannot grant financial authority | [Security](specs/security.md) |
| D06 | Isolated paper mode free within quota | Covers both sandbox meanings without unlimited spending | [Product](specs/product.md) |
| D07 | AWS/Fargate reference, one cloud initially | Managed task isolation; sponsor credits can change deployment selection after proof | [Hosting research](research/runtime-and-security.md) |
| D08 | Kimi first, Qwen second through provider-specific catalog | User sponsor preference without pretending parameters/prices are identical | [Sponsors](research/sponsors.md) |
| D09 | One verified Uniswap spot route first | Small complete trading capability before lending/orderbook complexity | [Connectors](specs/connectors.md) |
| D10 | Canonical finalized events for money and v1 triggers | Monad speculative receipts require explicit settlement logic | [Runtime](specs/runtime.md) |
| D11 | Basic timeline, budgets and pause are MVP | These controls are needed for operation; rich P&L/mobile can follow | [Product](specs/product.md) |
| D12 | No custom smart contract or token initially | Wallet infrastructure and accounting cover current requirements | [Architecture](../architecture.md) |
| D13 | No application code in current task | User asked for documents and scaffolding only | [Goals](../goals.md) |

## External gates and fallback behavior

| ID | Needed evidence | Owner / before | Fallback if unavailable |
| --- | --- | --- | --- |
| E01 | Current authenticated event deadline/timezone, track and exact bounty rules | Integration lead / G9 | Do not claim eligibility; submit only integrations actually demonstrated under confirmed rules |
| E02 | Cloud region, usable account credits/expiry, quotas, complete estimated bill, private egress support | Operations / hosted G4 | Trusted team-only paper demo locally; label it accordingly, never fake hardened hosting |
| E03 | Privy ownership, policy/admin separation, required signing method, export denial, idempotency and recovery | Funds/security / G5 and G8 | Remain paper-only; evaluate Dynamic only against a concrete failed requirement |
| E04 | Stablecoin address/decimals, MON funding, verified pair/router/ABI/liquidity/reference feed | Connector/funds / G8 | Use synthetic paper assets or a verified test deployment, clearly labeled |
| E05 | Kimi exact model/rates, bounded billed reasoning/output, API credentials; Qwen workspace/region if selected | API/model owner / G6 | Use a verified cheaper supported profile or deterministic no-AI preset; no silent model switch |
| E06 | Second RPC, actual finalized behavior, historical backfill limits and provider quotas | Connector/executor / G8 | Pause live execution on inability to prove canonical settlement |
| E07 | Public custody jurisdiction/terms, financial operations, refund/retention/recovery obligations | Project owner with appropriate advisers / G10 | Capped team-owned live demo only; no public deposits |
| E08 | Whether “Morpheus” means Morpho or another product | Product owner / optional connector work | Leave it out of enabled catalog; no effect on first slice |
| E09 | Exact compatible package versions/licenses, generated schema/type tool and SDK capability tests | Contract/integration / G1 | Pin compatible stable releases; update baseline only with evidence |

These gates need evidence, not a new major architecture exercise. They are intentionally not filled with guessed chain addresses, model IDs, credit balances or invented deadlines. Record the verified values, source/date and passing probe when closing them.

## Changing a decision

Add date, changed requirement/evidence, alternatives, chosen result, migration effect, owner and linked checks. Update the normative specification and consumers in the same reviewed change. Keep history for decisions that affect stored strategies, money records or signing authority; do not rewrite them as if the previous behavior never existed.
