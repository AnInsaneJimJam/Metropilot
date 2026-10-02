# Strategy rehearsal and language coverage

2026-10-02. Design hypothesis and source audit; no implementation or validated UX winner. Users author strategies.

## Visual proposal

**Playable rehearsal:** a price/event scene, synchronized highlights on the user's actual blocks/cards, and changing holdings. Scrub or advance one observation at a time. Selecting an effect focuses its originating block. Make non-actions visible: condition false, cooldown, stale input, insufficient available funds, or pending settlement.

Offer short synthetic scenarios first: crosses once, oscillates, gaps/stale data, failed/pending execution. Allow user-adjusted observations for “what if?” exploration. Historical replay is a later, separately labeled mode; TradingView documents play, stepping and adjustable replay speed, establishing a familiar interaction precedent, not proof of our usability. [Bar Replay](https://www.tradingview.com/support/solutions/43000712747-what-is-bar-replay/).

Rehearsal answers **what happens under these inputs**, not every possible future or guaranteed fills. Scenarios exercise reachable paths; uncovered branches stay visibly untested. Label source, revision, initial inventory/reservations, fees, fill assumptions and data granularity. Candle-only replay cannot establish intrabar crossing order. Future data stays unavailable to evaluation. AI steps use labeled supplied/recorded results; playback never implies that a future AI call returns the same result.

Technical proposal: cards/blocks → same validated AST → shared interpreter + simulated read/AI/effect host → trace keyed by node ID → synchronized scene/editor/holdings. Production executor remains authoritative. Emit proposed, blocked, pending and settled as different states; count holdings changes only for simulated settled effects. Avoid a second hand-written strategy evaluator in the product.

## Public strategy audit

These are published code examples, not verified live accounts or a representative survey. “Fits” means expressible by the current written spec, assuming the required catalog capabilities; nothing runs yet. Preserve complete entry, exit, sizing and order semantics when judging portability.

| Source / rule family | Current v1 coverage | Missing capability |
| --- | --- | --- |
| Recurring fixed spot purchase | Basic indefinite schedule + exact-input swap fits | Finite number of purchases/end date needs lifecycle state; not equivalent to a resting limit order |
| Fixed-price crossing / partial inventory sale (repo fixture) | Fits, including cooldown | Fraction means available input-token inventory, not account value or a named trade |
| [Strategy003, Gerald Lonlas](https://github.com/freqtrade/freqtrade-strategies/blob/main/user_data/strategies/Strategy003.py): indicator conjunction/OR, candle crosses, ROI by holding time, stop loss, limit entries | Boolean structure fits; full strategy does not | Historical candles/indicators, series-to-series crossings, positions/age/P&L, limit-order lifecycle |
| [BB_RSI, attributed to Leandro Handal](https://github.com/PeetCrypto/freqtrade-stuff/blob/main/BB_RSI.py): Bollinger/RSI entry and exit, trailing stop, time-dependent ROI | Full strategy does not fit | Indicators plus entry/peak/age state and order types |
| [DipBuyerStrategy, surendrad24](https://github.com/surendrad24/ZwaAP-FreqTrade-Strategies/blob/main/strategies/DipBuyerStrategy.py): candle filters, average down once after a 6% loss, trailing exit | Full strategy does not fit | Indicator warm-up, fill-derived entry cost, persistent entry count, relative-loss trigger, trailing state |
| [SimplePMM, Hummingbot](https://github.com/hummingbot/hummingbot/blob/master/scripts/simple_pmm.py): two resting orders around mid-price, cancel/refresh every 15 seconds | Does not fit | Limit orders/cancel/fills, persistent order state; current live schedule minimum is 60 seconds |
| [Grid executor](https://hummingbot.org/strategies/v2-strategies/executors/gridexecutor/): reusable entry/exit levels | Does not fit as a full grid | Per-level persistent state, order lifecycle, more than three triggers/intents where needed |
| [Arbitrage executor](https://hummingbot.org/strategies/v2-strategies/executors/arbitrage-executor/): fee-aware buy/sell across venues | Does not fit as equivalent arbitrage | Multi-venue capital and paired execution/recovery; sequential swaps do not provide simultaneous/atomic legs |

[Hummingbot's DCA page](https://hummingbot.org/strategies/v2-strategies/executors/dcaexecutor/) mixes interval prose with a price-level/limit-order configuration. Only the basic recurring-purchase concept maps directly; do not claim its whole executor is portable.

**Finding:** the present language is a bounded swap workflow language, not yet a complete entry/position/exit strategy language. Arbitrary `read` references do not establish indicator support: those operations require specified and available catalogs. The current arithmetic also lacks general unit-aware ratios, and swap amounts cannot consume arbitrary computed money expressions. Bounded `repeat` means immediate iterations in one run, not persistence over days.

## Smallest useful expansion to investigate

Prioritize candle-close observations with explicit timeframe/warm-up; a small vetted indicator set; series crossings; fill-derived positions with entry price/age/peak and once-only state; entry/exit sizing tied to a position. Specify stop-loss/take-profit/trailing precedence and gap behavior. Decide whether swap-at-signal is sufficient for target users before adding limit orders. Keep grids/market making/multi-venue arbitrage separate expansions.

This targets recurring gaps in the sampled directional spot strategies. It does **not** support a claim that we cover “most traders.” Next evidence: obtain complete strategies from target users and test whether they can predict actions and non-actions in rehearsal; measure errors, not satisfaction alone.

Method: three Exa searches/14 result entries screened, eight bounded source fetches (three public strategy files, one market-making script, three executor docs and TradingView). No code executed, performance claims assessed, interviews or usability tests conducted. Coverage checked against [strategy/1](../specs/strategy-language.md). [Board](https://www.tldraw.com/f/acimw4gVF5OICv0fB7EUA).
