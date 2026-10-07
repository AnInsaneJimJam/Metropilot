import type { RefObject, ReactNode } from "react";
import type { Experience } from "@monad-hack/strategy";
import type { Validation } from "./validation.ts";
import { StrategyPanel } from "./StrategyPanel.tsx";
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
            <h2>Strategy canvas</h2>
            <p>Connect a trigger to the actions it should take.</p>
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
            strategy/1
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
