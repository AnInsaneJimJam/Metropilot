# Product specification

Version: 1.0 design baseline. Owner: product/integration role. Status: not implemented.

## User and promise

A non-technical retail trader can configure an agent, understand its authority and operating costs, test it, launch it, and stop it without managing servers, API keys, protocol tooling, or code. The service supplies credentials and infrastructure through its own accounts. The product is automation infrastructure; none of its templates is represented as investment advice or a profitable strategy.

The latest brief chooses custody: the platform can authorize transactions on the user's behalf. Explain that plainly before real funds are accepted. A single visible wallet has three budgets, while actual enforcement and settlement remain server-side. Avoid the claims “risk-free,” “agent knows everything,” “unlimited free hosting,” and “optimal profit.”

## Modes

| Mode | Editable | Defaults and restrictions |
| --- | --- | --- |
| Rookie | Same blocks and toolbox as advanced (decision D17, 2026-10-03), usually starting from a preset; optional supported model choice | Stricter limits only: paper only, schedule ≥ 60 s, slippage ≤ 50 bps, at most 1 AI call and 1 intent per run; reviewed presets, short tutorial, explicit promotion to live |
| Advanced | Full supported block vocabulary, model/prompt/reasoning settings, capabilities, budget allocation, resource profile within catalog | Same hard platform safety limits; no arbitrary executable uploads, endpoints, shell, unlimited spend, or key access |
| Connector-only | Operator configuration and external runtime | Distributed separately after hosted MVP; keys/hosting/policy are the operator's responsibility; no hosted custody or free model entitlement |

Rookie and advanced compile to the same strategy format and use the same editor; rookie differs only by the stricter limits above, checked in the editor and again at deployment. Switching modes preserves the document; a document outside rookie limits stays advanced rather than being silently simplified. Sandbox/live is a separate axis from rookie/advanced.

## Onboarding contract

1. **Landing and sign-in:** explain the product, supported chain, custody, sandbox limits, and early-access status. Sign in before saving an agent or consuming sponsored compute.
2. **Choose mode and connectors:** show live/paper readiness and exact supported actions. Multiple selections are allowed, but a selected connector grants only explicitly enabled capabilities. Disabled/unverified entries explain why and cannot launch.
3. **Build strategy:** select a preset or edit blocks, configure AI nodes, and view a plain-language summary. Validate missing inputs, data types, unavailable capabilities, loops, and limits in context. Include keyboard-accessible forms/tree editing alongside drag/drop.
4. **Allocate costs:** paper gets virtual balances plus a separate sponsored quota. Live displays deposit address/network/asset and waits for finalized funding. Set hosting, API, and trading budgets; show MON reserve inside trading, quote age, rate card, and expected/worst-case operating runway.
5. **Review and launch:** display strategy revision, connectors, model settings, budget limits, quote expiry, resource profile, custody and allowed recipients. One final launch action submits an idempotent request. Real-money authorization requires step-up verification.
6. **Status:** show queued/provisioning/running/paused/failed states, why an action happened or was blocked, remaining budgets, last event, and pending transaction status. Resume requires current health/capability/funds validation.

Wizard drafts autosave with revision conflict protection. Refreshing resumes a draft. Missing funding does not discard the strategy. Reject launch when estimates/capabilities are stale, providing a path to refresh them. Never automatically convert a paper deployment into live mode.

## Four initial presets

All are demonstration templates with configurable, prominently displayed limits, not recommended investments. Pair selection is from the verified catalog. Initial fixtures use synthetic paper assets, not counterfeit mainnet token addresses.

| Preset | Blocks / behavior | Editable parameters |
| --- | --- | --- |
| Observe and explain | On a schedule, read a price and optionally ask AI for a structured summary; no trade | Market, interval, AI on/off and supported model |
| Scheduled fixed purchase | On each scheduled trigger, buy a fixed amount through the selected swap connector | Market, amount, interval, total spend cap |
| Threshold partial sale | When fresh price crosses above a threshold, sell a fraction of available selected-token holdings | Threshold, percentage, cooldown, minimum position |
| AI-gated purchase | On a schedule, provide bounded observations to AI; trade a fixed allowed amount only when output is `allow` | Inputs, prompt, model setting, amount, frequency |

The first observation initializes a crossing baseline rather than firing. A price staying above the threshold does not repeatedly sell. Neither AI confidence nor a preset can expand spending authority. Live loss, price, fee, and liquidity checks still apply.

## Sandbox contract

There are three distinct features: execution isolation, paper trading, and pre-sign transaction simulation. Both live and paper agents are isolated. Paper positions and fills are synthetic; they never become withdrawable balances. Simulation does not guarantee a later trade's outcome.

Initial free quota: one concurrently running paper agent per user, 60 minutes per session, 120 minutes per UTC day, 20 AI calls per day, and a platform-rated AI allowance of USD 0.10/day, whichever limit is reached first. These are configurable **product launch defaults**, not verified vendor prices or a promise that every model fits. The model catalog can mark expensive calls unavailable under free quota. Charge no user funds for sponsored sandbox consumption. Global admission caps can temporarily queue/refuse sessions before launch, with an explanation.

Use live observations when available but label synthetic fixtures, delayed data, and simulated fills. The paper broker applies declared fee/slippage assumptions and configured liquidity limits. It does not fabricate profitable fills on missing data. New live deployment starts with actual live inventory and no carried-over paper P&L or authority.

## Monitoring scope

Required for MVP: lifecycle/health, event timeline, selected inputs and concise decision explanation, allowed/blocked reason, transaction state/link, per-category usage, and pause/stop. This minimum is necessary to operate the agent even though advanced monitoring is later.

Later: realized/unrealized performance, fee breakdown, historical comparison, alerts, multiple-agent overview improvements, and mobile. A future P&L view uses finalized fills and explicit cost basis, reports deposits/withdrawals separately, and distinguishes trading performance from total performance after hosting/model costs. Stale/missing prices produce unavailable valuation, not zero loss.

## Acceptance boundaries

A user can finish the hosted paper flow without entering provider/cloud credentials. Every blocked action has a readable reason. Customization stays inside catalog and policy limits. Drafts survive failed provisioning. Pause works without losing history. Withdrawals work independently of strategy compute when live custody is enabled. Public docs explain templates, budgets, sandbox limitations, data delay, and custody before presenting advanced options.

Exact protocol additions, mobile delivery, and public launch dates are not implied by the scaffold. See [goals](../../goals.md) for implementation status.
