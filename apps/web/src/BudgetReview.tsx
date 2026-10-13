import { paperBudgetIssue } from "@monad-hack/contracts";
import type { Statement } from "@monad-hack/contracts";
import { toAtomic, fromAtomic } from "@monad-hack/strategy";
import type { Validation } from "./validation.ts";
import type { SaveRequest } from "./api.ts";
export const DEFAULT_BUDGET: SaveRequest["budget"] = {
  tradingUsdMicros: "1000000000",
  hostingUsdMicros: "10000000",
  dataAndAiUsdMicros: "5000000",
  monReserveAtomic: "1000000000000000000",
};
const fields = [
  [
    "tradingUsdMicros",
    "Trading",
    "Virtual USDC units for trades",
    6,
    "USDC",
  ],
  ["hostingUsdMicros", "Hosting", "Operating limit", 6, "USD"],
  [
    "dataAndAiUsdMicros",
    "Data & AI",
    "Used only by AI blocks",
    6,
    "USD",
  ],
  [
    "monReserveAtomic",
    "Network reserve",
    "Virtual MON for network fees",
    18,
    "MON",
  ],
] as const;
function slippages(body: Statement[]): number[] {
  return body.flatMap((node) =>
    node.type === "swap.exactInput"
      ? [node.maxSlippageBps]
      : node.type === "if"
        ? [...slippages(node.then), ...slippages(node.else)]
        : node.type === "repeat"
          ? slippages(node.body)
          : [],
  );
}
export function BudgetReview({
  budget,
  onBudget,
  validation,
  onOperate,
}: {
  budget: SaveRequest["budget"];
  onBudget: (b: SaveRequest["budget"]) => void;
  validation: Validation | undefined;
  onOperate: () => void;
}) {
  const issue = paperBudgetIssue(
    budget,
    Boolean(validation?.program?.bounds.aiCalls),
  );
  const bps =
    validation?.strategy?.triggers.flatMap((trigger) =>
      slippages(trigger.body),
    ) ?? [];
  const total = ["hostingUsdMicros", "dataAndAiUsdMicros"]
    .reduce((n, k) => n + BigInt(budget[k as keyof typeof budget]), 0n)
    .toString();
  return (
    <section className="review-page" aria-label="Budget review">
      <div className="review-grid">
        <div className="budget-section">
          <div className="section-line">
            <h3>Budget</h3>
            <span className="muted">Virtual funds</span>
          </div>
          {fields.map(([key, label, hint, decimals, unit]) => (
            <div className="budget-row" key={key}>
              <div>
                <h4>{label}</h4>
                <p>{hint}</p>
              </div>
              <label className="money-input">
                <span className="visually-hidden">
                  {label} limit in {unit}
                </span>
                <input
                  key={budget[key]}
                  defaultValue={fromAtomic(budget[key], decimals)}
                  inputMode="decimal"
                  aria-label={`${label} limit in ${unit}`}
                  onBlur={(e) => {
                    try {
                      const atomic = toAtomic(e.target.value, decimals);
                      onBudget({ ...budget, [key]: atomic });
                      e.currentTarget.setCustomValidity("");
                    } catch {
                      e.currentTarget.value = fromAtomic(budget[key], decimals);
                      e.currentTarget.setCustomValidity(
                        "Enter a nonnegative decimal amount.",
                      );
                      e.currentTarget.reportValidity();
                    }
                  }}
                  onInput={(e) => e.currentTarget.setCustomValidity("")}
                />
                <span>{unit}</span>
              </label>
            </div>
          ))}
          <div className="budget-total">
            <span>Operating limit</span>
            <strong>
              {fromAtomic(total, 6)} <small>USD</small>
            </strong>
          </div>
          {issue && (
            <p className="budget-error" role="alert">
              {issue}
            </p>
          )}
          <p
            className="note"
            title="Trading funds become virtual USDC units at launch; this is not a USD conversion. Maximum 10,000 trading units. MON reserve is separate. These are saved limits, not a deposit or a billed estimate."
          >
            Trading is in virtual USDC units, operating limits in USD. Limits
            only, not a deposit.
          </p>
        </div>
        <aside className="review-aside">
          <h3>Per run</h3>
          <dl className="review-limits">
            <div>
              <dt>Trades</dt>
              <dd>{validation?.program?.bounds.intents ?? "—"}</dd>
            </div>
            <div>
              <dt>AI calls</dt>
              <dd>{validation?.program?.bounds.aiCalls ?? "—"}</dd>
            </div>
            <div>
              <dt>Max slippage</dt>
              <dd>{bps.length ? `${Math.max(...bps) / 100}%` : "No trades"}</dd>
            </div>
          </dl>
        </aside>
      </div>
      <div className="execution-gate">
        <span className="status-dot" aria-hidden="true" />
        <p title="Paper launch runs on the local stack. Cloud hosting and live trading are not connected yet.">
          Save this revision, then launch it on paper.
        </p>
        <button className="primary" onClick={onOperate}>
          Go to Operate
        </button>
      </div>
    </section>
  );
}
