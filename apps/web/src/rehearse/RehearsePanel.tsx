import { useEffect, useState } from "react";
import type * as Blockly from "blockly/core";
import type { CompiledStrategy } from "@monad-hack/strategy";
import { editorCatalog } from "../catalog.ts";
import { AI_SCRIPTS, rehearse, SCENARIOS, START_HOLDINGS } from "./simulate.ts";
import type { AiScript, Rehearsal, ScenarioId } from "./simulate.ts";
import { PriceChart, elapsedLabel } from "./PriceChart.tsx";
import { Icon } from "../Icon.tsx";
export function RehearsePanel({
  workspace,
  program,
  onOperate,
}: {
  workspace: Blockly.WorkspaceSvg | undefined;
  program: CompiledStrategy | undefined;
  onOperate: () => void;
}) {
  const scheduled = Boolean(
    program &&
    !program.strategy.triggers.some(
      (t) => t.type === "price.crossesAbove" || t.type === "price.crossesBelow",
    ),
  );
  const [scenario, setScenario] = useState<ScenarioId>("crossesOnce");
  const [aiScript, setAiScript] = useState<AiScript>("allow");
  const [result, setResult] = useState<
    { hash: string; rehearsal: Rehearsal } | { error: string }
  >();
  const [block, setBlock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  useEffect(() => {
    setPlaying(false);
    setBlock(0);
    setResult(undefined);
    if (!program || Object.values(editorCatalog.feeds).some((f) => f.quoteUnit === 'USDC')) return;
    let active = true;
    rehearse(program, editorCatalog, scenario, aiScript).then(
      (rehearsal) => {
        if (active) setResult({ hash: program.hash, rehearsal });
      },
      (error) => {
        if (active) setResult({ error: String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [program, scenario, aiScript]);
  const rehearsal =
    result && "rehearsal" in result && result.hash === program?.hash
      ? result.rehearsal
      : undefined;
  const last = rehearsal
    ? Math.max(
        rehearsal.ticks.at(-1)?.block ?? 0,
        rehearsal.events.at(-1)?.block ?? 0,
      )
    : 0;
  useEffect(() => {
    if (!playing || !rehearsal) return;
    const t = setInterval(
      () =>
        setBlock((b) => {
          const next = Math.min(
            b +
              (scheduled
                ? Math.max(1, Math.ceil(last / (speed === 10 ? 120 : 24)))
                : Math.max(
                    1,
                    Math.round((50 * speed) / rehearsal.blockMillis),
                  )),
            last,
          );
          if (next === last) setPlaying(false);
          return next;
        }),
      50,
    );
    return () => clearInterval(t);
  }, [playing, rehearsal, speed, last, scheduled]);
  const shown = rehearsal?.events.filter((e) => e.block <= block) ?? [];
  const latest = shown.at(-1);
  const tick = rehearsal?.ticks.findLast((t) => t.block <= block);
  const done = Boolean(rehearsal && block >= last);
  useEffect(() => {
    if (!workspace) return;
    workspace.highlightBlock(null);
    for (const id of latest?.nodeIds ?? [])
      if (workspace.getBlockById(id)) workspace.highlightBlock(id, true);
  }, [workspace, latest]);
  useEffect(() => () => workspace?.highlightBlock(null), [workspace]);
  const trigger = program?.strategy.triggers.find(
    (t) => t.type === "price.crossesAbove" || t.type === "price.crossesBelow",
  );
  const threshold =
    trigger &&
    (trigger.type === "price.crossesAbove" ||
      trigger.type === "price.crossesBelow")
      ? Number(trigger.threshold.decimal)
      : undefined;
  const usesAi = Boolean(program?.bounds.aiCalls);
  const outcome = shown.findLast((e) =>
    ["completed", "failed", "pending", "settled", "command", "fire"].includes(
      e.kind,
    ),
  );
  const trades = shown.filter((e) => e.kind === "settled").length;
  if (Object.values(editorCatalog.feeds).some((f) => f.quoteUnit === "USDC"))
    return (
      <section className="rehearse-page" aria-labelledby="rehearse-heading">
        <div className="native-note">
          <span className="eyebrow">Mainnet data</span>
          <h2 id="rehearse-heading">Native market observations.</h2>
          <p>
            These strategies use finalized Monad mainnet data: Uniswap’s
            30-second geometric TWAP, Curve’s native EMA, and Aave’s native USD
            prices and reserve rates. Scenario playback for these oracle methods
            is not available yet.
          </p>
          <button className="primary" onClick={onOperate}>
            Run on paper in Operate
          </button>
        </div>
      </section>
    );
  return (
    <section className="rehearse-page" aria-labelledby="rehearse-heading">
      <h2 id="rehearse-heading" className="visually-hidden">
        Rehearse
      </h2>
      {!program ? (
        <div className="empty-state">Fix the problems in Build to rehearse.</div>
      ) : (
        <>
          <div className="scenario-bar">
            <label>
              Scenario
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value as ScenarioId)}
              >
                {SCENARIOS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {usesAi && (
              <label>
                Scripted AI answer
                <select
                  value={aiScript}
                  onChange={(e) => setAiScript(e.target.value as AiScript)}
                >
                  {AI_SCRIPTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p
              className="synthetic-label"
              title={
                scheduled
                  ? "Three schedule slots at a fixed synthetic reference price. Playback compresses time."
                  : SCENARIOS.find((s) => s.id === scenario)?.summary
              }
            >
              Synthetic rehearsal — not a paper or live fill
            </p>
          </div>
          {result && "error" in result && <p role="alert">{result.error}</p>}
          <div className="chart-panel">
            <div className="chart-heading">
              <div>
                <span className="eyebrow">Synthetic WETH / USD</span>
                <strong>
                  {tick?.twap ?? "—"}
                  <small>30s TWAP</small>
                </strong>
              </div>
              <span className="chart-legend">
                <span className="status-dot" />
                TWAP{" "}
                {threshold !== undefined && (
                  <>
                    <span className="legend-threshold" />
                    Threshold
                  </>
                )}
              </span>
            </div>
            {rehearsal ? (
              <PriceChart
                rehearsal={rehearsal}
                block={block}
                threshold={threshold}
              />
            ) : (
              <div className="empty-state">Preparing scenario…</div>
            )}
            <div className="playback">
              <button
                className="primary"
                disabled={!rehearsal || done}
                onClick={() => setPlaying((p) => !p)}
              >
                <Icon name={playing ? "pause" : "play"} size={14} />
                {playing ? "Pause" : block ? "Resume" : "Play"}
              </button>
              <label className="scrubber">
                <span className="visually-hidden">Rehearsal position</span>
                <input
                  type="range"
                  min="0"
                  max={last || 1}
                  value={block}
                  disabled={!rehearsal}
                  onChange={(e) => {
                    setPlaying(false);
                    setBlock(Number(e.target.value));
                  }}
                />
              </label>
              <span className="block-count">
                {elapsedLabel((block * (rehearsal?.blockMillis ?? 0)) / 1000)}
              </span>
              <button
                disabled={!rehearsal || done}
                onClick={() => {
                  setPlaying(false);
                  setBlock(last);
                }}
              >
                <Icon name="skip" size={14} />
                Skip to end
              </button>
              <button
                disabled={!block}
                onClick={() => {
                  setPlaying(false);
                  setBlock(0);
                }}
              >
                <Icon name="reset" size={14} />
                Reset
              </button>
              <label className="speed">
                <span className="visually-hidden">Speed</span>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  <option value="10">
                    {scheduled ? "6s overview" : "10×"}
                  </option>
                  <option value="50">
                    {scheduled ? "1.2s overview" : "50×"}
                  </option>
                </select>
              </label>
            </div>
          </div>
          <div className="outcome-strip" aria-live="polite">
            <div>
              <span className="eyebrow">Triggers</span>
              <strong>{shown.filter((e) => e.kind === "fire").length}</strong>
            </div>
            <div>
              <span className="eyebrow">Settled</span>
              <strong>{trades}</strong>
            </div>
            <div className="outcome-status">
              <span className="eyebrow">Outcome</span>
              <p>
                {outcome?.text ?? "Press play to run the scenario."}
              </p>
            </div>
          </div>
          <section className="holdings">
            <h3 className="eyebrow">Holdings</h3>
            <div>
              {Object.entries(
                done && rehearsal ? rehearsal.holdings : START_HOLDINGS,
              ).map(([ref, value]) => (
                <div key={ref}>
                  <span>{ref.slice(ref.lastIndexOf(".") + 1)}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </section>
          <details className="trace-details">
            <summary>
              Inspect the execution trace <span>{shown.length} events</span>
            </summary>
            <dl className="bounds" aria-label="Synthetic feed">
              <dt>Block</dt>
              <dd>{block}</dd>
              <dt>Pool spot</dt>
              <dd>{tick?.spot ?? "—"}</dd>
              <dt>TWAP</dt>
              <dd>{tick?.twap ?? "warming up"}</dd>
            </dl>
            <ol className="rehearse-log" aria-label="Rehearsal log">
              {shown.map((e, i) => (
                <li key={i} className={`event-${e.kind}`}>
                  <span>#{e.block}</span>
                  {e.text}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
