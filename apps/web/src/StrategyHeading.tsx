import { useEffect } from "react";
import type { Validation } from "./validation.ts";
import type { SavedAgent } from "./api.ts";
import { Icon } from "./Icon.tsx";
export type Stage = "build" | "rehearse" | "review" | "operate";
export interface Notice {
  readonly text: string;
  readonly tone: "ok" | "warn" | "error";
}
const STAGES = [
  ["build", "Build"],
  ["rehearse", "Rehearse"],
  ["review", "Review"],
  ["operate", "Operate"],
] as const;
export function StrategyHeading({
  name,
  dirty,
  current,
  connected,
  saving,
  validation,
  budgetIssue,
  notice,
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
  notice: Notice | undefined;
  stage: Stage;
  onName: (name: string) => void;
  onSave: () => void;
  onDismiss: () => void;
  onReconnect: () => void;
  onStage: (stage: Stage) => void;
}) {
  const problems = validation?.problems.length ?? 0;
  const valid = Boolean(validation?.program && !problems);
  // Why Save is unavailable, shown as its tooltip rather than as more text on the page.
  const blocked = !connected
    ? "Control API offline"
    : !name.trim()
      ? "Name the strategy first"
      : !validation?.program || problems
        ? "Fix the strategy problems first"
        : budgetIssue
          ? budgetIssue
          : current && !dirty
            ? "No changes to save"
            : undefined;
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);
  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <h1 className="visually-hidden">{name || "Untitled strategy"}</h1>
          <label className="strategy-name">
            <span className="visually-hidden">Strategy name</span>
            <input
              maxLength={120}
              value={name}
              placeholder="Untitled strategy"
              size={Math.max(12, Math.min(name.length + 1, 36))}
              onChange={(e) => {
                onName(e.target.value);
              }}
            />
          </label>
          <span
            className="pill paper"
            title="Paper execution on mainnet market data. No real funds move."
          >
            Paper
          </span>
        </div>
        <nav className="stage-tabs" aria-label="Strategy workflow">
          <ol>
            {STAGES.map(([s, label], i) => (
              <li key={s}>
                <button
                  aria-current={stage === s ? "step" : undefined}
                  onClick={() => onStage(s)}
                >
                  <span>0{i + 1}</span>
                  {label}
                  {s === "build" && valid && <Icon name="check" size={13} />}
                  {s === "build" && problems > 0 && (
                    <em className="tab-count" aria-hidden="true">
                      {problems}
                    </em>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="save-controls">
          <span className={`save-state ${dirty ? "dirty" : ""}`}>
            {dirty ? "Unsaved" : current ? `Rev ${current.version}` : "Draft"}
          </span>
          <button
            className="primary"
            onClick={() => onSave()}
            title={blocked}
            disabled={saving || Boolean(blocked)}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      {notice && (
        <div className={`toast tone-${notice.tone}`} role="status">
          <Icon name={notice.tone === "ok" ? "check" : "alert"} size={15} />
          <span>{notice.text}</span>
          {!connected && (
            <button className="link" onClick={onReconnect}>
              Reconnect
            </button>
          )}
          <button
            className="toast-close"
            aria-label="Dismiss message"
            onClick={() => onDismiss()}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </>
  );
}
