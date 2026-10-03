import { advanceRun, fromAtomic, scheduleSlot, startRun, transitionPrice } from '@monad-hack/strategy';
import type { Catalog, CompiledStrategy, CrossingState, HostCommand, HostResponse } from '@monad-hack/strategy';
import type { RunCheckpoint, Trigger } from '@monad-hack/contracts';

// Synthetic rehearsal: finalized-block pool prices at the catalog's block cadence, a 30 s-style TWAP over them,
// and the real engine (transitionPrice, scheduleSlot, startRun, advanceRun) driven by a synthetic paper host.
// Nothing here is a paper or live fill. Pure and deterministic, so the same inputs give the same trace.

export type ScenarioId = 'crossesOnce' | 'oscillates' | 'staleGap' | 'pendingFill';
export const SCENARIOS: readonly { readonly id: ScenarioId; readonly label: string; readonly summary: string }[] = [
  { id: 'crossesOnce', label: 'Crosses once', summary: 'Pool price steps from 1 below the threshold to 1, then 2, past it.' },
  { id: 'oscillates', label: 'Oscillates', summary: 'Pool price swings 2 either side of the threshold every 40 s.' },
  { id: 'staleGap', label: 'Stale gap', summary: 'Finalized blocks stop arriving for 45 s while the price crosses.' },
  { id: 'pendingFill', label: 'Pending fill', summary: 'Crosses once, but the synthetic fill stays pending for 20 s.' },
];

export type EventKind = 'info' | 'non-action' | 'fire' | 'command' | 'pending' | 'settled' | 'completed' | 'failed';
export interface TraceEvent {
  readonly block: number;
  readonly kind: EventKind;
  readonly text: string;
  /** AST node IDs, which are also the Blockly block IDs, active after this event. Empty clears the highlight. */
  readonly nodeIds: readonly string[];
}
export interface Tick { readonly block: number; readonly timeMs: number; readonly spot?: string; readonly twap?: string }
export interface Rehearsal {
  readonly blockMillis: number;
  readonly ticks: readonly Tick[];
  readonly events: readonly TraceEvent[];
  readonly holdings: Readonly<Record<string, string>>;
}

const SCALE = 10n ** 18n;
const START = Date.UTC(2026, 0, 1);
const SEGMENT_MS = 40_000;
const PENDING_MS = 20_000;
const GAP_MS = 45_000;
const SCHEDULE_SLOTS = 3;
/** Flat synthetic TWAP for every feed when no price trigger shapes one (schedule-only strategies). */
const REFERENCE_TWAP = '2500';
/** Synthetic starting balances, in human units. */
export const START_HOLDINGS: Readonly<Record<string, string>> = { 'paper.WETH': '1', 'paper.USD': '2500', 'paper.MON': '5' };

type PriceTrigger = Extract<Trigger, { type: 'price.crossesAbove' | 'price.crossesBelow' }>;
type ScheduleTrigger = Extract<Trigger, { type: 'schedule' }>;

function scaled(text: string): bigint {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0').slice(0, 18) || '0');
}
/** 18-place scaled value → canonical language decimal (positive only here). */
function canonical(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return (value / SCALE).toString() + (fraction ? '.' + fraction : '');
}
const iso = (ms: number): string => new Date(ms).toISOString();
const symbol = (ref: string): string => ref.slice(ref.lastIndexOf('.') + 1);

/** Spot price per block for one feed, from the first price trigger that watches it. */
function spotPath(trigger: PriceTrigger, scenario: ScenarioId, blockMillis: number): { blocks: number; spot: (block: number) => bigint } {
  const threshold = scaled(trigger.threshold.decimal);
  const up = trigger.type === 'price.crossesAbove' ? 1n : -1n;
  const offset = (units: bigint): bigint => { const v = threshold + up * units * SCALE; return v > 0n ? v : threshold / 2n; };
  const segments = scenario === 'oscillates' ? [-2n, 2n, -2n, 2n, -2n, 2n] : [-1n, 1n, 2n];
  const perSegment = Math.ceil(SEGMENT_MS / blockMillis);
  return { blocks: perSegment * segments.length, spot: block => offset(segments[Math.min(Math.floor(block / perSegment), segments.length - 1)]!) };
}

interface Run { checkpoint: RunCheckpoint; command?: HostCommand; pendingUntil?: number }

export async function rehearse(program: CompiledStrategy, catalog: Catalog, scenario: ScenarioId): Promise<Rehearsal> {
  const events: TraceEvent[] = []; const ticks: Tick[] = [];
  const triggers = program.strategy.triggers;
  const priceTriggers = triggers.filter((t): t is PriceTrigger => t.type === 'price.crossesAbove' || t.type === 'price.crossesBelow');
  const schedules = triggers.filter((t): t is ScheduleTrigger => t.type === 'schedule');
  const networkRef = Object.values(catalog.assets)[0]?.networkRef ?? '';
  const network = Object.hasOwn(catalog.networks, networkRef) ? catalog.networks[networkRef]! : undefined;
  if (!network) throw new Error(`The catalog has no block cadence for ${networkRef}.`);
  const { blockMillis, finalityBlocks } = network;

  const holdings = new Map<string, bigint>();
  for (const [ref, human] of Object.entries(START_HOLDINGS)) {
    const asset = catalog.assets[ref];
    if (asset) holdings.set(ref, scaled(human) / 10n ** BigInt(18 - asset.decimals));
  }
  const human = (ref: string, atomicValue: bigint): string => `${fromAtomic(atomicValue.toString(), catalog.assets[ref]?.decimals ?? 18)} ${symbol(ref)}`;
  const latestTwap = new Map<string, bigint>();

  // Synthetic paper host: fills at the latest TWAP moved against the user by the full allowed slippage.
  const fill = (command: Extract<HostCommand, { kind: 'swap.exactInput' }>): { ok: true; text: string } | { ok: false; text: string } => {
    const inAsset = catalog.assets[command.tokenInRef]; const outAsset = catalog.assets[command.tokenOutRef];
    const feed = Object.entries(catalog.feeds).find(([, f]) =>
      (f.baseAssetRef === command.tokenInRef && symbol(command.tokenOutRef) === f.quoteUnit) || (f.baseAssetRef === command.tokenOutRef && symbol(command.tokenInRef) === f.quoteUnit));
    const price = feed ? latestTwap.get(feed[0]) : undefined;
    if (!inAsset || !outAsset || !feed || !price) return { ok: false, text: `No synthetic ${symbol(command.tokenInRef)}/${symbol(command.tokenOutRef)} price yet, so the synthetic host rejects the swap.` };
    const balance = holdings.get(command.tokenInRef) ?? 0n;
    const amountIn = command.amount.kind === 'fixed' ? BigInt(command.amount.atomic) : balance * BigInt(command.amount.bps) / 10_000n;
    if (amountIn === 0n || amountIn > balance) return { ok: false, text: `Synthetic balance is ${human(command.tokenInRef, balance)}; the swap needs ${human(command.tokenInRef, amountIn)}, so it is rejected.` };
    const unitIn = 10n ** BigInt(inAsset.decimals); const unitOut = 10n ** BigInt(outAsset.decimals);
    const selling = feed[1].baseAssetRef === command.tokenInRef;
    const gross = selling ? amountIn * price * unitOut / (unitIn * SCALE) : amountIn * SCALE * unitOut / (price * unitIn);
    const amountOut = gross * BigInt(10_000 - command.maxSlippageBps) / 10_000n;
    holdings.set(command.tokenInRef, balance - amountIn);
    holdings.set(command.tokenOutRef, (holdings.get(command.tokenOutRef) ?? 0n) + amountOut);
    return { ok: true, text: `Synthetic fill: ${human(command.tokenInRef, amountIn)} → ${human(command.tokenOutRef, amountOut)} at TWAP ${canonical(price)} less ${command.maxSlippageBps} bps.` };
  };

  let run: Run | undefined;
  const activeIds = (r: Run): string[] => [r.checkpoint.triggerId, ...r.checkpoint.frames.slice(1).map(f => f.ownerId), ...(r.checkpoint.waiting ? [r.checkpoint.waiting.nodeId] : [])];
  // Advances the active run until it waits on something unresolved or ends.
  const drive = async (block: number, response?: HostResponse): Promise<void> => {
    while (run) {
      const result = await advanceRun(program, run.checkpoint, response); response = undefined;
      run.checkpoint = result.checkpoint;
      if (result.command) delete run.command;
      if (!result.command) {
        const failed = result.checkpoint.status === 'failed';
        events.push({ block, kind: failed ? 'failed' : 'completed', nodeIds: failed && result.checkpoint.error?.nodeId ? [result.checkpoint.error.nodeId] : [],
          text: failed ? `Run stopped: ${result.checkpoint.error?.code} — ${result.checkpoint.error?.message}` : `Run completed: ${result.checkpoint.intents} trade, ${result.checkpoint.steps} steps.` });
        run = undefined; return;
      }
      const command = result.command; run.command = command;
      if (command.kind === 'notify') {
        events.push({ block, kind: 'command', nodeIds: activeIds(run), text: `Notify: "${command.message}" (synthetic, acknowledged).` });
        response = { key: command.key, outcome: 'acknowledged' }; continue;
      }
      events.push({ block, kind: 'command', nodeIds: activeIds(run), text: `Proposed swap: ${symbol(command.tokenInRef)} → ${symbol(command.tokenOutRef)}, max slippage ${command.maxSlippageBps} bps.` });
      if (scenario === 'pendingFill' && run.pendingUntil === undefined) {
        run.pendingUntil = block + Math.ceil(PENDING_MS / blockMillis);
        events.push({ block, kind: 'pending', nodeIds: activeIds(run), text: 'Fill pending: later blocks wait; the notification stays blocked.' }); return;
      }
      const outcome = fill(command);
      events.push({ block, kind: outcome.ok ? 'settled' : 'failed', nodeIds: activeIds(run), text: outcome.text });
      response = { key: command.key, outcome: outcome.ok ? 'settled' : 'rejected' };
    }
  };
  const fire = async (block: number, trigger: Trigger, sourceEventKey: string, why: string): Promise<void> => {
    if (run) { events.push({ block, kind: 'non-action', nodeIds: activeIds(run), text: `${trigger.id} fired, but a run is still waiting; one run per agent, so it is skipped.` }); return; }
    events.push({ block, kind: 'fire', nodeIds: [trigger.id], text: `${trigger.id} fired: ${why}.` });
    run = { checkpoint: await startRun(program, { deploymentRevision: 'synthetic-rehearsal', triggerId: trigger.id, sourceEventKey }) };
    await drive(block);
  };
  const resumePending = async (block: number): Promise<void> => {
    if (run?.pendingUntil === undefined || block < run.pendingUntil || run.command?.kind !== 'swap.exactInput') return;
    const outcome = fill(run.command);
    events.push({ block, kind: outcome.ok ? 'settled' : 'failed', nodeIds: activeIds(run), text: outcome.text });
    await drive(block, { key: run.command.key, outcome: outcome.ok ? 'settled' : 'rejected' });
  };

  if (priceTriggers.length === 0) {
    // Schedule-only strategies: jump the clock slot to slot instead of playing every block.
    if (schedules.length === 0) events.push({ block: 0, kind: 'info', nodeIds: [], text: 'No price or schedule trigger to rehearse.' });
    for (const feedRef of Object.keys(catalog.feeds)) latestTwap.set(feedRef, scaled(REFERENCE_TWAP));
    events.push({ block: 0, kind: 'info', nodeIds: [], text: `No price trigger, so fills use a flat synthetic TWAP of ${REFERENCE_TWAP} and only Pending fill changes anything. Skipping ahead ${SCHEDULE_SLOTS} schedule slots.` });
    const first = Math.min(...schedules.map(t => Date.parse(t.anchorAt)));
    const step = Math.min(...schedules.map(t => t.intervalSeconds)) * 1000;
    const last = new Map<string, string>();
    for (let slot = 0; slot < SCHEDULE_SLOTS && schedules.length; slot++) {
      const now = first + slot * step; const block = slot * Math.ceil(step / blockMillis);
      ticks.push({ block, timeMs: now - first });
      for (const t of schedules) {
        const accepted = scheduleSlot(t, iso(now), last.get(t.id));
        if (!accepted) continue;
        last.set(t.id, accepted);
        await resumePending(Number.MAX_SAFE_INTEGER);
        await fire(block, t, `synthetic:${t.id}:${accepted}`, `schedule slot ${accepted}`);
      }
    }
    await resumePending(Number.MAX_SAFE_INTEGER);
    return { blockMillis, ticks, events, holdings: Object.fromEntries([...holdings].map(([ref, v]) => [ref, human(ref, v)])) };
  }

  // One price path per feed, shaped by the first trigger that watches it.
  const paths = new Map<string, ReturnType<typeof spotPath>>();
  for (const t of priceTriggers) if (!paths.has(t.feedRef)) paths.set(t.feedRef, spotPath(t, scenario, blockMillis));
  const total = Math.max(...[...paths.values()].map(p => p.blocks)) + finalityBlocks;
  const gapStart = Math.ceil(SEGMENT_MS / blockMillis); // just before the TWAP would cross
  const gapEnd = gapStart + Math.ceil(GAP_MS / blockMillis);
  const states = new Map<string, CrossingState>(); const lastReason = new Map<string, string>();
  const scheduleLast = new Map<string, string>();
  events.push({ block: 0, kind: 'info', nodeIds: [], text: `Synthetic finalized blocks every ${blockMillis} ms, finalized ${finalityBlocks} blocks later. Triggers need a full TWAP window first.` });

  for (let block = finalityBlocks; block < total; block++) {
    const now = START + block * blockMillis;
    const finalized = block - finalityBlocks; // the newest block that is final at `now`
    const tick: { block: number; timeMs: number; spot?: string; twap?: string } = { block, timeMs: block * blockMillis };
    await resumePending(block);
    if (scenario === 'staleGap' && block === gapStart) events.push({ block, kind: 'info', nodeIds: [], text: 'Finalized blocks stop arriving (synthetic outage).' });
    const delivering = !(scenario === 'staleGap' && block >= gapStart && block < gapEnd);
    for (const [feedRef, path] of paths) {
      const feed = catalog.feeds[feedRef]!;
      tick.spot = canonical(path.spot(Math.min(finalized, path.blocks - 1)));
      const window = Math.ceil(feed.windowSeconds * 1000 / blockMillis);
      if (finalized + 1 < window || !delivering) continue;
      // After the outage, the first delivery is the backlog's oldest block: already too old to count.
      const observedBlock = scenario === 'staleGap' && block === gapEnd ? gapStart - finalityBlocks : finalized;
      let sum = 0n;
      for (let b = observedBlock - window + 1; b <= observedBlock; b++) sum += path.spot(Math.min(b, path.blocks - 1));
      const twap = sum / BigInt(window);
      latestTwap.set(feedRef, twap); tick.twap = canonical(twap);
      for (const t of priceTriggers.filter(p => p.feedRef === feedRef)) {
        const observation = { sourceEventKey: `synthetic:${feedRef}:${observedBlock}`, feedRef, price: { ...t.threshold, decimal: canonical(twap) }, observedAt: iso(START + observedBlock * blockMillis), receivedAt: iso(now) };
        const decision = transitionPrice(t, states.get(t.id) ?? {}, observation, iso(now));
        states.set(t.id, decision.state);
        if (decision.fire) { await fire(block, t, observation.sourceEventKey, `TWAP ${canonical(twap)} crossed ${t.threshold.decimal}`); lastReason.set(t.id, 'crossing'); continue; }
        if (decision.reason === lastReason.get(t.id)) continue; // report changes, not every block
        lastReason.set(t.id, decision.reason);
        const text = {
          baseline: `${t.id}: TWAP ${canonical(twap)} recorded as the baseline; a crossing needs a later block.`,
          'no-crossing': `${t.id}: no crossing (TWAP ${canonical(twap)}, threshold ${t.threshold.decimal}).`,
          cooldown: `${t.id}: crossed again at TWAP ${canonical(twap)}, but the ${t.cooldownSeconds} s cooldown blocks it.`,
          stale: `${t.id}: observation is older than ${t.maxAgeSeconds} s, so it is ignored and the baseline resets.`,
          'out-of-order': `${t.id}: out-of-order observation ignored.`,
          crossing: '',
        }[decision.reason];
        events.push({ block, kind: 'non-action', nodeIds: run ? activeIds(run) : [], text });
      }
    }
    for (const t of schedules) {
      const accepted = scheduleSlot(t, iso(now), scheduleLast.get(t.id));
      if (!accepted) continue;
      scheduleLast.set(t.id, accepted);
      await fire(block, t, `synthetic:${t.id}:${accepted}`, `schedule slot ${accepted}`);
    }
    ticks.push(tick);
  }
  if (run) events.push({ block: total, kind: 'info', nodeIds: activeIds(run), text: 'Rehearsal ended with the run still waiting.' });
  return { blockMillis, ticks, events, holdings: Object.fromEntries([...holdings].map(([ref, v]) => [ref, human(ref, v)])) };
}
