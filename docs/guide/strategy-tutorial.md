# Tutorial: a threshold sale in paper mode

Status: tutorial specification for the future application. All prices and assets in this example are synthetic. It teaches block behavior rather than suggesting a trade.

## The rule

“When the price of my selected paper asset crosses above 2,500 USD, sell 10% of the available position. Wait at least an hour before accepting another crossing.”

1. Start a paper agent in rookie mode and choose the threshold partial-sale preset.
2. Select the paper swap connector and the synthetic WETH/USD market.
3. Set the crossing threshold to 2,500 and the position percentage to 10%.
4. Keep the one-hour cooldown. Set a maximum trade amount and daily action limit in the permission review.
5. Review the plain-language summary and launch using virtual funds.

The “when” block is a trigger. It watches an approved, timestamped price feed. The action block proposes a swap. The execution policy checks the proposed amount and current available position before it can become a paper fill or live transaction.

## What should happen

| Observations in order | Expected behavior |
| --- | --- |
| First price 2,499 | Establish a baseline; no sale |
| Next fresh price 2,501 | One upward crossing; propose a 10% sale |
| Next price 2,502 | Still above; no new crossing and no second sale |
| Duplicate 2,501 event after reconnect | Same event identity; no additional sale |
| Missing/stale price then fresh price above threshold | Re-establish baseline; do not assume a crossing happened during the gap |

“10%” refers to the selected token's available trading inventory at authorization time. It excludes reserved amounts and operating funds. A trade can still be blocked by a smaller amount cap, insufficient gas in live mode, stale reference data, or poor liquidity.

## Add an AI decision

In advanced mode, place an AI decision before the swap and an `if` block around the action. Supply approved observations as inputs, select a supported model/profile, and use the structured `allow`/`skip` response. Execute the swap only in the `allow` branch.

Changing the prompt or model changes a draft. A running deployment keeps its approved revision until you explicitly redeploy. An invalid response, timeout or exhausted AI budget stops the run; it does not count as permission to trade. The activity view shows a brief explanation and charged usage, not a promise of access to the model's private reasoning.

## Before switching to live

Live requires its own verified network/assets, funded custody wallet and gas, fresh cost estimate, explicit permissions and new deployment. Virtual positions, simulated profit and paper wallet IDs are never carried into live funds. Review the actual amounts and limits again; successful paper behavior does not establish investment performance.
