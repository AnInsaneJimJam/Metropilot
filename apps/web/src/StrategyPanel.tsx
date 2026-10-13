import type { ReactNode } from "react";
import type { Experience } from "@monad-hack/strategy";
import type { Validation } from "./validation.ts";
interface Props {
  experience: Experience;
  onExperience: (e: Experience) => void;
  validation: Validation | undefined;
  onFocusBlock: (id: string, field: string | undefined) => void;
  outline: ReactNode;
}
const PROFILE_HINT = {
  rookie: "One trade per run, at most 0.5% slippage",
  advanced: "Expanded run limits, same hard safety checks",
} as const;
export function StrategyPanel({
  experience,
  onExperience,
  validation,
  onFocusBlock,
  outline,
}: Props) {
  const ready = validation && !validation.problems.length && validation.program;
  return (
    <aside className="editor-panel" aria-label="Strategy checks">
      <section className="check-section" aria-labelledby="check-heading">
        <h2 id="check-heading" className="visually-hidden">
          Strategy checks
        </h2>
        <div
          className={`check-state ${ready ? "ready" : validation ? "" : "pending"}`}
          role="status"
          aria-live="polite"
        >
          <span className="status-dot" />
          {!validation
            ? "Checking changes…"
            : ready
              ? "Ready for paper"
              : `${validation.problems.length} ${validation.problems.length === 1 ? "problem" : "problems"} to fix`}
        </div>
        {validation?.problems.length ? (
          <ul className="problems">
            {validation.problems.map((p, i) => (
              <li key={i}>
                {p.blockId ? (
                  <button
                    className="link"
                    onClick={() => onFocusBlock(p.blockId!, p.field)}
                  >
                    {p.message}
                  </button>
                ) : (
                  p.message
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {outline}
      <fieldset className="experience">
        <legend>Profile</legend>
        <div className="segmented-radio">
          {(["rookie", "advanced"] as const).map((e) => (
            <label key={e} title={PROFILE_HINT[e]}>
              <input
                type="radio"
                name="experience"
                checked={experience === e}
                onChange={() => onExperience(e)}
              />
              {e === "rookie" ? "Rookie" : "Advanced"}
            </label>
          ))}
        </div>
      </fieldset>
      <details className="technical">
        <summary>Compiler details</summary>
        <dl className="bounds">
          <dt>Steps</dt>
          <dd>{validation?.program?.bounds.steps ?? "—"}</dd>
          <dt>Trades</dt>
          <dd>{validation?.program?.bounds.intents ?? "—"}</dd>
          <dt>AI calls</dt>
          <dd>{validation?.program?.bounds.aiCalls ?? "—"}</dd>
        </dl>
        {validation?.program && (
          <code className="hash">{validation.program.hash}</code>
        )}
      </details>
    </aside>
  );
}
