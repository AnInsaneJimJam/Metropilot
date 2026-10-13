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
    "Virtual USDC units available to your strategy",
    6,
    "USDC",
  ],
  ["hostingUsdMicros", "Hosting", "Separate operating limit", 6, "USD"],
  [
    "dataAndAiUsdMicros",
    "Data & AI",
    "Only used by explicit AI blocks",
    6,
    "USD",
  ],
  [
    "monReserveAtomic",
    "Network reserve",
    "Virtual MON kept for network costs",
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
      <div className="section-intro">
        <span className="eyebrow">03 / REVIEW</span>
        <h2>Set the boundaries.</h2>
        <p>
          Your rules decide what happens. These limits decide how far it can go.
        </p>
      </div>
      <div className="review-grid">
        <div className="budget-section">
          <div className="section-line">
            <h3>Paper allocation</h3>
            <span className="pill">Virtual funds</span>
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
            <span>Operating USD limit</span>
            <strong>
              {fromAtomic(total, 6)} <small>USD</small>
            </strong>
          </div>
          {issue && (
            <p className="budget-error" role="alert">
              {issue}
            </p>
          )}
          <p className="note">
            Trading funds become virtual USDC units at launch; this is not a USD conversion. Maximum 10,000 trading units. MON reserve is separate. These are saved
            limits, not a deposit or a billed estimate. Trading USDC and operating USD are separate denominations.
          </p>
        </div>
        <aside className="review-aside">
          <span className="eyebrow">MAXIMUM PER RUN</span>
          <dl className="review-limits">
            <div>
              <dt>Trade intents</dt>
              <dd>{validation?.program?.bounds.intents ?? "—"}</dd>
            </div>
            <div>
              <dt>AI calls</dt>
              <dd>{validation?.program?.bounds.aiCalls ?? "—"}</dd>
            </div>
            <div>
              <dt>Maximum slippage</dt>
              <dd>{bps.length ? `${Math.max(...bps) / 100}%` : "No trades"}</dd>
            </div>
          </dl>
          <div className="boundary-note">
            <h4>Paper stays paper.</h4>
            <p>
              No wallet is connected and no real funds move. Live mode requires
              a verified execution route and explicit consent.
            </p>
          </div>
        </aside>
      </div>
      <div className="execution-gate">
        <span className="status-dot amber" />
        <div>
          <h3>Paper launch runs on the local stack</h3>
          <p>
            Save this revision, then launch, pause and stop it in Operate. Cloud
            hosting and live trading are not connected yet.
          </p>
        </div>
        <button onClick={onOperate}>Go to Operate</button>
      </div>
    </section>
  );
}
