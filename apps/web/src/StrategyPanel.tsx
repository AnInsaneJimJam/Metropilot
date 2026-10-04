import { useState } from 'react';
import type { ReactNode } from 'react';
import { PROFILE_LIMITS } from '@monad-hack/strategy';
import type { Experience } from '@monad-hack/strategy';
import type { Validation } from './validation.ts';
import { PRESETS } from './presets/index.ts';
import type { Preset } from './presets/index.ts';
import { Tutorial } from './presets/Tutorial.tsx';

interface Props {
  readonly experience: Experience;
  readonly onExperience: (experience: Experience) => void;
  readonly validation: Validation | undefined;
  readonly onFocusBlock: (blockId: string, field: string | undefined) => void;
  readonly onLoadPreset: (preset: Preset) => void;
  readonly onStartTutorial: () => void;
  /** The keyboard outline, shown right under the checks so problem links lead into it. */
  readonly outline?: ReactNode;
  /** The rehearse section, shown under the worst-case bounds. */
  readonly children?: ReactNode;
}

function Status({ validation, experience }: Pick<Props, 'validation' | 'experience'>) {
  if (!validation) return <p>Checking…</p>;
  const count = validation.problems.length;
  if (count === 0) return <p className="status-ok">Ready: valid for {experience} paper.</p>;
  return <p className="status-error">{count === 1 ? '1 problem' : `${count} problems`} to fix{validation.program ? ` (it compiles, but not within ${experience} limits)` : ''}.</p>;
}

export function StrategyPanel({ experience, onExperience, validation, onFocusBlock, onLoadPreset, onStartTutorial, outline, children }: Props) {
  const [presetId, setPresetId] = useState(PRESETS[0]?.id ?? '');
  const preset = PRESETS.find(p => p.id === presetId);
  const limits = validation?.strategy?.limits;
  const bounds = validation?.program?.bounds;
  return (
    <aside className="editor-panel" aria-label="Strategy checks">
      <fieldset className="experience">
        <legend>Experience</legend>
        {(['rookie', 'advanced'] as const).map(value => (
          <label key={value}>
            <input type="radio" name="experience" value={value} checked={experience === value} onChange={() => onExperience(value)} />
            {value === 'rookie' ? 'Rookie' : 'Advanced'}
          </label>
        ))}
        <p className="muted">
          {experience === 'rookie'
            ? `Same blocks, stricter limits: paper only, schedules ≥ ${PROFILE_LIMITS.scheduleSeconds.otherwise} s, slippage ≤ ${PROFILE_LIMITS.slippageBps.rookie} bps, ${PROFILE_LIMITS.rookie.maxAiCallsPerRun} AI call and ${PROFILE_LIMITS.rookie.maxIntentsPerRun} trade per run.`
            : `Paper schedules from ${PROFILE_LIMITS.scheduleSeconds.paperAdvanced} s; slippage ≤ ${PROFILE_LIMITS.slippageBps.platform} bps. Live will need ≥ ${PROFILE_LIMITS.scheduleSeconds.otherwise} s.`}
        </p>
      </fieldset>

      <section aria-labelledby="check-heading">
        <h2 id="check-heading">Check</h2>
        <div role="status" aria-live="polite"><Status validation={validation} experience={experience} /></div>
        {validation && validation.problems.length > 0 && (
          <ul className="problems">
            {validation.problems.map((p, i) => (
              <li key={`${p.blockId ?? ''}-${i}`}>
                {p.blockId
                  ? <button type="button" className="link" onClick={() => onFocusBlock(p.blockId!, p.field)}>{p.message}</button>
                  : p.message}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">The server reruns these checks on save; they guide you here. Choose a problem to edit its block.</p>
      </section>

      {outline}

      <section aria-labelledby="bounds-heading">
        <h2 id="bounds-heading">Worst case per run</h2>
        {bounds && limits ? (
          <dl className="bounds">
            <dt>Steps</dt><dd>{bounds.steps} / {limits.maxStepsPerRun}</dd>
            <dt>Trades</dt><dd>{bounds.intents} / {limits.maxIntentsPerRun}</dd>
            <dt>AI calls</dt><dd>{bounds.aiCalls} / {limits.maxAiCallsPerRun}</dd>
          </dl>
        ) : <p className="muted">Shown once the strategy compiles.</p>}
        <h3>Strategy hash</h3>
        {validation?.program ? <code className="hash">{validation.program.hash}</code> : <p className="muted">None yet.</p>}
      </section>

      {children}

      <section aria-labelledby="presets-heading">
        <h2 id="presets-heading">Presets</h2>
        <label className="stacked">
          Start from
          <select value={presetId} onChange={e => setPresetId(e.target.value)}>
            {PRESETS.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </label>
        {preset && <p className="muted">{preset.summary}</p>}
        <button type="button" disabled={!preset} onClick={() => preset && onLoadPreset(preset)}>Replace canvas with preset</button>
        <p className="muted">Undo (Ctrl+Z / ⌘Z) restores your previous blocks.</p>
      </section>

      <Tutorial experience={experience} validation={validation} onStart={onStartTutorial} />
    </aside>
  );
}
