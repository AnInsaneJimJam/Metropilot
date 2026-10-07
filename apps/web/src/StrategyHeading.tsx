import type { Validation } from "./validation.ts";
import type { SavedAgent } from "./api.ts";
import { Icon } from "./Icon.tsx";
export type Stage = "build" | "rehearse" | "review";
export function StrategyHeading({
  name,
  dirty,
  current,
  connected,
  saving,
  validation,
  budgetIssue,
  message,
  stage,
  onName,
  onSave,
  onDismiss,
  onReconnect,
  onStage,
}: {
  name: string;
  dirty: boolean;
  current: SavedAgent | undefined;
  connected: boolean;
  saving: boolean;
  validation: Validation | undefined;
  budgetIssue: string | undefined;
  message: string;
  stage: Stage;
  onName: (name: string) => void;
  onSave: () => void;
  onDismiss: () => void;
  onReconnect: () => void;
  onStage: (stage: Stage) => void;
}) {
  return (
    <>
      <div className="strategy-header">
        <div>
          <h1 className="visually-hidden">{name || "Untitled strategy"}</h1>
          <div className="title-meta">
            <span className="pill">
              <span className="status-dot" />
              Paper
            </span>
            <span className="muted">
              {current ? `Revision ${current.version}` : "Unsaved draft"}
            </span>
          </div>
          <label className="strategy-name">
            <span className="visually-hidden">Strategy name</span>
            <input
              maxLength={120}
              value={name}
              onChange={(e) => {
                onName(e.target.value);
              }}
            />
          </label>
          <p className="header-caption">
            Define the rules. See every consequence.
          </p>
        </div>
        <div className="save-controls">
          <span className="save-state">
            {dirty
              ? "Unsaved changes"
              : current
                ? "All changes saved"
                : "Not saved yet"}
          </span>
          <button
            className="primary"
            onClick={() => onSave()}
            disabled={
              !connected ||
              !name.trim() ||
              !validation?.program ||
              Boolean(validation.problems.length) ||
              Boolean(budgetIssue) ||
              saving ||
              Boolean(current && !dirty)
            }
          >
            {saving ? "Saving…" : "Save revision"}
            <span className="button-arrow">
              <Icon name="arrow" />
            </span>
          </button>
        </div>
      </div>
      {message && (
        <div className="message" role="status">
          <span>{message}</span>
          {!connected && (
            <button className="link" onClick={onReconnect}>
              Reconnect
            </button>
          )}
          <button aria-label="Dismiss message" onClick={() => onDismiss()}>
            ×
          </button>
        </div>
      )}
      <nav className="stage-tabs" aria-label="Strategy workflow">
        {(["build", "rehearse", "review"] as const).map((s, i) => (
          <button
            key={s}
            aria-current={stage === s ? "step" : undefined}
            onClick={() => onStage(s)}
          >
            <span>0{i + 1}</span>
            {s === "build" ? "Build" : s === "rehearse" ? "Rehearse" : "Review"}
            {s === "build" &&
              validation?.program &&
              !validation.problems.length && <Icon name="check" size={14} />}
          </button>
        ))}
        <span className="workflow-note">
          <Icon name="shield" size={14} />
          {validation?.program && !validation.problems.length
            ? "Strategy validated"
            : "Validation required"}
        </span>
      </nav>
    </>
  );
}
