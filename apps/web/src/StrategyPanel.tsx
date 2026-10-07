import type { ReactNode } from "react";
import type { Experience } from "@monad-hack/strategy";
import type { Validation } from "./validation.ts";
import { Icon } from "./Icon.tsx";
interface Props {
  experience: Experience;
  onExperience: (e: Experience) => void;
  validation: Validation | undefined;
  onFocusBlock: (id: string, field: string | undefined) => void;
  outline: ReactNode;
}
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
      <div className="panel-heading">
        <span className="eyebrow">INSPECTOR</span>
        <Icon name="settings" />
      </div>
      <section className="check-section" aria-labelledby="check-heading">
        <h2 id="check-heading">Strategy checks</h2>
        <div
          className={`check-state ${ready ? "ready" : ""}`}
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
        ) : (
          <p className="muted">
            Types, connections and run limits checked. The server checks again
            on save.
          </p>
        )}
      </section>
      <fieldset className="experience">
        <legend>Safety profile</legend>
        {(["rookie", "advanced"] as const).map((e) => (
          <label key={e}>
            <input
              type="radio"
              name="experience"
              checked={experience === e}
              onChange={() => onExperience(e)}
            />
            {e === "rookie" ? "Rookie" : "Advanced"}
          </label>
        ))}
        <p className="muted">
          {experience === "rookie"
            ? "One trade per run · ≤ 0.5% slippage"
            : "Expanded run limits · same hard safety checks"}
        </p>
      </fieldset>
      {outline}
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
