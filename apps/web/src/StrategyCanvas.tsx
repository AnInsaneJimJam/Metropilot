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
  onZoom,
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
  onZoom: (step: number) => void;
  onUndo: () => void;
}) {
  return (
    <div className="build-stage" hidden={!visible}>
      <div className="canvas-column">
        <div className="canvas-toolbar">
          <h2 className="visually-hidden">Strategy canvas</h2>
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
          {view === "blocks" && (
            <div className="canvas-tools">
              <button
                className="icon-button"
                aria-label="Undo"
                title="Undo"
                onClick={onUndo}
              >
                <Icon name="undo" size={15} />
              </button>
              <span className="tool-divider" aria-hidden="true" />
              <button
                className="icon-button"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() => onZoom(-1)}
              >
                <Icon name="minus" size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => onZoom(1)}
              >
                <Icon name="plus" size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Fit canvas"
                title="Fit canvas"
                onClick={onFit}
              >
                <Icon name="fit" size={15} />
              </button>
            </div>
          )}
          <button className="ghost templates" onClick={onPatterns}>
            <Icon name="blocks" size={14} />
            Templates
          </button>
        </div>
        <div
          ref={canvas}
          className="editor-canvas"
          hidden={view !== "blocks"}
          role="region"
          aria-label="Strategy blocks canvas"
        />
        {view === "rules" && <div className="rules-view">{outline}</div>}
      </div>
      <StrategyPanel
        experience={experience}
        onExperience={onExperience}
        validation={validation}
        onFocusBlock={focus}
        outline={view === "blocks" ? outline : null}
      />
    </div>
  );
}
