import { useEffect, useMemo, useState } from 'react';
import type * as Blockly from 'blockly/core';
import type { CompiledStrategy } from '@monad-hack/strategy';
import { editorCatalog } from '../catalog.ts';
import { AI_SCRIPTS, rehearse, SCENARIOS, START_HOLDINGS } from './simulate.ts';
import type { AiScript, Rehearsal, ScenarioId } from './simulate.ts';

const SPEEDS = [10, 50] as const;
const FRAME_MS = 50;
const LABEL = 'Synthetic rehearsal — not a paper or live fill';

interface Props {
  readonly workspace: Blockly.WorkspaceSvg | undefined;
  /** Only a compiled program rehearses; profile problems do not block rehearsal. */
  readonly program: CompiledStrategy | undefined;
}

export function RehearsePanel({ workspace, program }: Props) {
  const [scenario, setScenario] = useState<ScenarioId>('crossesOnce');
  const [aiScript, setAiScript] = useState<AiScript>('allow');
  const [result, setResult] = useState<{ hash: string; scenario: ScenarioId; rehearsal: Rehearsal } | { error: string }>();
  const usesAi = program?.canonicalJson.includes('"type":"ai.decide"') ?? false;
  const [block, setBlock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(10);

  // Recompute whenever the strategy or scenario changes; a stale result is dropped.
  useEffect(() => {
    setPlaying(false); setBlock(0); setResult(undefined);
    if (!program) return;
    let current = true;
    rehearse(program, editorCatalog, scenario, aiScript).then(
      rehearsal => { if (current) setResult({ hash: program.hash, scenario, rehearsal }); },
      (error: unknown) => { if (current) setResult({ error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [program, scenario, aiScript]);

  const rehearsal = result && 'rehearsal' in result ? result.rehearsal : undefined;
  const lastBlock = rehearsal ? Math.max(rehearsal.ticks.at(-1)?.block ?? 0, rehearsal.events.at(-1)?.block ?? 0) : 0;

  useEffect(() => {
    if (!playing || !rehearsal) return;
    const blocksPerFrame = Math.max(1, Math.round(FRAME_MS * speed / rehearsal.blockMillis));
    const timer = setInterval(() => setBlock(b => {
      const next = Math.min(b + blocksPerFrame, lastBlock);
      if (next === lastBlock) setPlaying(false);
      return next;
    }), FRAME_MS);
    return () => clearInterval(timer);
  }, [playing, rehearsal, speed, lastBlock]);

  const shown = useMemo(() => rehearsal?.events.filter(e => e.block <= block) ?? [], [rehearsal, block]);
  const tick = useMemo(() => rehearsal?.ticks.findLast(t => t.block <= block), [rehearsal, block]);
  const done = rehearsal !== undefined && block >= lastBlock;

  // Highlight the blocks of the latest event, using Blockly's execution highlight (block IDs are AST node IDs).
  const active = shown.at(-1)?.nodeIds;
  useEffect(() => {
    if (!workspace) return;
    workspace.highlightBlock(null);
    for (const id of active ?? []) if (workspace.getBlockById(id)) workspace.highlightBlock(id, true);
  }, [workspace, active]);
  useEffect(() => () => workspace?.highlightBlock(null), [workspace]);

  return (
    <section aria-labelledby="rehearse-heading" className="rehearse">
      <h2 id="rehearse-heading">Rehearse</h2>
      <p className="synthetic-label">{LABEL}</p>
      {!program ? <p className="muted">Fix the problems above to rehearse.</p> : (
        <>
          <label className="stacked">
            Scenario
            <select value={scenario} onChange={e => setScenario(e.target.value as ScenarioId)}>
              {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <p className="muted">{SCENARIOS.find(s => s.id === scenario)?.summary}</p>
          {usesAi && (
            <label className="stacked">
              Scripted AI answer (no model is called)
              <select value={aiScript} onChange={e => setAiScript(e.target.value as AiScript)}>
                {AI_SCRIPTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          )}
          <div className="rehearse-controls">
            <button type="button" disabled={!rehearsal || done} onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : block ? 'Resume' : 'Play'}</button>
            <button type="button" disabled={!rehearsal || done} onClick={() => { setPlaying(false); setBlock(lastBlock); }}>Skip to end</button>
            <button type="button" disabled={!rehearsal || block === 0} onClick={() => { setPlaying(false); setBlock(0); }}>Reset</button>
            <label>
              Speed{' '}
              <select value={speed} onChange={e => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}>
                {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
              </select>
            </label>
          </div>
          {result && 'error' in result && <p className="status-error">{result.error}</p>}
          {rehearsal && (
            <dl className="bounds" aria-label="Synthetic feed">
              <dt>Block</dt><dd>{block} (t+{((tick?.timeMs ?? 0) / 1000).toFixed(1)} s)</dd>
              <dt>Pool spot</dt><dd>{tick?.spot ?? '—'}</dd>
              <dt>TWAP</dt><dd>{tick?.twap ?? 'warming up'}</dd>
            </dl>
          )}
          <ol className="rehearse-log" aria-live="polite" aria-label="Rehearsal log">
            {shown.map((e, i) => <li key={i} className={`event-${e.kind}`}><span className="muted">#{e.block}</span> {e.text}</li>)}
          </ol>
          <h3>Synthetic holdings</h3>
          <p className="muted">
            {done && rehearsal
              ? Object.values(rehearsal.holdings).join(' · ')
              : `Start: ${Object.entries(START_HOLDINGS).map(([ref, v]) => `${v} ${ref.slice(ref.lastIndexOf('.') + 1)}`).join(' · ')}`}
          </p>
        </>
      )}
    </section>
  );
}
