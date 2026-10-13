import { useEffect, useRef } from "react";
import { PRESETS } from "./presets/index.ts";
import { BrandMark, Icon } from "./Icon.tsx";
export function PresetPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  // A modal dialog traps focus and closes on Escape natively. Unmounting removes it, which ends the modal;
  // closing it in a cleanup would fire `close` during StrictMode's effect replay and dismiss it at once.
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="preset-picker"
      aria-labelledby="preset-heading"
      onClose={() => onClose()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        className="icon-button dialog-close"
        aria-label="Close"
        onClick={() => onClose()}
      >
        <Icon name="close" size={15} />
      </button>
      <header className="dialog-hero">
        <BrandMark size={40} />
        <h2 id="preset-heading">
          Your strategy, <em>on autopilot.</em>
        </h2>
        <p>Start from a template. Every block stays editable.</p>
      </header>
      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button key={p.id} onClick={() => onPick(p.id)}>
            <span>
              <h3>{p.title}</h3>
              <p>{p.summary}</p>
            </span>
            <Icon name="arrow" size={16} />
          </button>
        ))}
      </div>
      <footer className="dialog-foot">
        <span>No-code trading agents · Built on Monad</span>
        <span>Examples, not investment advice</span>
      </footer>
    </dialog>
  );
}
