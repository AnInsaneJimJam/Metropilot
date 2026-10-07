import type { RefObject, ReactNode } from "react";
import type { Experience } from "@monad-hack/strategy";
import type { Validation } from "./validation.ts";
import { StrategyPanel } from "./StrategyPanel.tsx";
import { Icon } from "./Icon.tsx";
export function StrategyCanvas({
  visible,
  canvas,
  view,
  setView,
  outline,
  experience,
  onExperience,
  validation,
  focus,
  onPatterns,
  onFit,
  onUndo,
}: {
  visible: boolean;
  canvas: RefObject<HTMLDivElement | null>;
  view: "blocks" | "rules";
  setView: (view: "blocks" | "rules") => void;
  outline: ReactNode;
  experience: Experience;
  onExperience: (e: Experience) => void;
  validation: Validation | undefined;
  focus: (id: string, field: string | undefined) => void;
  onPatterns: () => void;
  onFit: () => void;
  onUndo: () => void;
}) {
  return (
    <div className="build-stage" hidden={!visible}>
      <div className="canvas-column">
        <div className="canvas-toolbar">
          <div>
            <span className="canvas-label">
              <Icon name="layers" size={15} />
              <h2>Strategy canvas</h2>
              <span className="canvas-version">strategy/1</span>
            </span>
            <p>Compose your logic. Select a block to fine-tune it.</p>
          </div>
          <div className="segmented" aria-label="Editor view">
            <button
              aria-pressed={view === "blocks"}
              onClick={() => setView("blocks")}
            >
              Blocks
            </button>
            <button
              aria-pressed={view === "rules"}
              onClick={() => setView("rules")}
            >
              Rules
            </button>
          </div>
        </div>
        <div
          ref={canvas}
          className="editor-canvas"
          hidden={view !== "blocks"}
          role="region"
          aria-label="Strategy blocks canvas"
        />
        {view === "rules" && <div className="rules-view">{outline}</div>}
        <div className="canvas-footer">
          <span>
            <span className="status-dot" />
            {validation?.program
              ? `${validation.program.bounds.steps} steps · ${validation.program.bounds.intents} trade${validation.program.bounds.intents === 1 ? "" : "s"} per run`
              : "Waiting for valid rules"}
          </span>
          <button className="link" onClick={onFit}>
            Fit canvas
          </button>
          <button className="link" onClick={onUndo}>
            Undo
          </button>
          <button className="link" onClick={onPatterns}>
            Browse patterns
          </button>
        </div>
      </div>
      <StrategyPanel
        experience={experience}
        onExperience={onExperience}
        validation={validation}
        onFocusBlock={focus}
        outline={
          view === "blocks" ? (
            outline
          ) : (
            <p className="muted">Edit a rule in the main workspace.</p>
          )
        }
      />
    </div>
  );
}
