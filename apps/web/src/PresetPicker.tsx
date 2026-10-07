import { PRESETS } from "./presets/index.ts";
import { Icon } from "./Icon.tsx";
export function PresetPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <section className="preset-picker" aria-label="Choose a starting point">
      <div className="section-line">
        <h2>Start with a pattern</h2>
        <button className="link" onClick={() => onClose()}>
          Close
        </button>
      </div>
      <p>Examples to edit, not investment recommendations.</p>
      <div className="preset-grid">
        {PRESETS.map((p, i) => (
          <button key={p.id} onClick={() => onPick(p.id)}>
            <span className="eyebrow">0{i + 1}</span>
            <span>
              <h3>{p.title}</h3>
              <p>{p.summary}</p>
            </span>
            <Icon name="arrow" />
          </button>
        ))}
      </div>
    </section>
  );
}
