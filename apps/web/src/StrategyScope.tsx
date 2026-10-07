import type { Validation } from "./validation.ts";
import { assetSymbol, editorCatalog } from "./catalog.ts";

/** A glance at the compiled document, never a forecast or a claim about live execution. */
export function StrategyScope({
  validation,
}: {
  validation: Validation | undefined;
}) {
  const strategy = validation?.program?.strategy;
  const trigger =
    strategy?.triggers.length === 1 ? strategy.triggers[0] : undefined;
  const price =
    trigger &&
    (trigger.type === "price.crossesAbove" ||
      trigger.type === "price.crossesBelow")
      ? trigger
      : undefined;
  const feed = price ? editorCatalog.feeds[price.feedRef] : undefined;
  const schedule = trigger?.type === "schedule" ? trigger : undefined;
  const interval = schedule?.intervalSeconds;
  const frequency = interval
    ? interval % 86400 === 0
      ? `${interval / 86400}d`
      : interval % 3600 === 0
        ? `${interval / 3600}h`
        : interval % 60 === 0
          ? `${interval / 60}m`
          : `${interval}s`
    : undefined;
  return (
    <div className="strategy-scope" aria-label="Compiled strategy scope">
      <div className="scope-identity">
        <span className="scope-emblem" aria-hidden="true">
          ◇
        </span>
        <span>
          <small>{feed ? "MARKET" : "STRATEGY"}</small>
          <strong>
            {feed
              ? `${assetSymbol(feed.baseAssetRef)} / ${feed.quoteUnit}`
              : `${strategy?.triggers.length ?? "—"} triggers`}
          </strong>
        </span>
      </div>
      <div>
        <small>TRIGGER</small>
        <strong>
          {price
            ? `Crosses ${price.type === "price.crossesAbove" ? "above" : "below"} ${price.threshold.decimal} ${price.threshold.quoteUnit}`
            : frequency
              ? `Every ${frequency}`
              : strategy
                ? "Multiple rules"
                : "Needs validation"}
        </strong>
      </div>
      <div>
        <small>MAXIMUM / RUN</small>
        <strong>
          {validation?.program
            ? `${validation.program.bounds.intents} trade${validation.program.bounds.intents === 1 ? "" : "s"} · ${validation.program.bounds.aiCalls} AI call${validation.program.bounds.aiCalls === 1 ? "" : "s"}`
            : "—"}
        </strong>
      </div>
      <span className="scope-mode">SYNTHETIC</span>
    </div>
  );
}
