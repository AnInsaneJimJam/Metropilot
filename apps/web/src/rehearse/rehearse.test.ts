import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileStrategy, syntheticCatalog, PRESETS } from '@monad-hack/strategy';
import { rehearse } from './simulate.ts';
import type { Rehearsal } from './simulate.ts';

const program = (id: string) => compileStrategy(JSON.stringify(PRESETS.find(p => p.id === id)!.strategy), syntheticCatalog);
const kinds = (r: Rehearsal, kind: string) => r.events.filter(e => e.kind === kind);

test('crosses once: fires once, sells 10% of WETH, notifies and completes', async () => {
  const r = await rehearse(await program('threshold_sale'), syntheticCatalog, 'crossesOnce');
  assert.equal(kinds(r, 'fire').length, 1);
  assert.deepEqual(kinds(r, 'fire')[0]!.nodeIds, ['crossing']);
  assert.equal(kinds(r, 'settled').length, 1);
  assert.ok(kinds(r, 'command').some(e => e.nodeIds.includes('record_result')));
  assert.equal(kinds(r, 'completed').length, 1);
  assert.equal(r.holdings['paper.WETH'], '0.9 WETH');
  assert.ok(r.events.some(e => e.text.includes('baseline')) && r.events.some(e => e.text.includes('no crossing')));
});

test('oscillation fires once, then the cooldown blocks later crossings', async () => {
  const r = await rehearse(await program('threshold_sale'), syntheticCatalog, 'oscillates');
  assert.equal(kinds(r, 'fire').length, 1);
  assert.ok(r.events.some(e => e.text.includes('cooldown blocks it')));
});

test('a stale gap ignores the late observation, resets the baseline and misses the crossing', async () => {
  const r = await rehearse(await program('threshold_sale'), syntheticCatalog, 'staleGap');
  assert.ok(r.events.some(e => e.text.includes('older than 30 s')));
  assert.equal(kinds(r, 'fire').length, 0);
});

test('a pending fill blocks the notification until it settles', async () => {
  const r = await rehearse(await program('threshold_sale'), syntheticCatalog, 'pendingFill');
  const pending = kinds(r, 'pending')[0]!; const settled = kinds(r, 'settled')[0]!;
  const notify = r.events.find(e => e.kind === 'command' && e.nodeIds.includes('record_result'))!;
  assert.ok(pending.block < settled.block && settled.block <= notify.block);
  assert.equal(settled.block - pending.block, Math.ceil(20_000 / syntheticCatalog.networks['paper-monad']!.blockMillis));
});

test('schedule-only strategies jump slot to slot and buy with USD', async () => {
  const r = await rehearse(await program('scheduled_purchase'), syntheticCatalog, 'crossesOnce');
  assert.equal(kinds(r, 'fire').length, 3);
  assert.equal(kinds(r, 'settled').length, 3);
  assert.equal(kinds(r, 'completed').length, 3);
  assert.equal(r.holdings['paper.USD'], '2425 USD'); // 3 × 25 USD at the flat synthetic TWAP
});

test('rehearsal is deterministic', async () => {
  const p = await program('threshold_sale');
  assert.deepEqual(await rehearse(p, syntheticCatalog, 'oscillates'), await rehearse(p, syntheticCatalog, 'oscillates'));
});

test('observe and explain reads the TWAP, records a scripted summary and never trades', async () => {
  const r = await rehearse(await program('observe_explain'), syntheticCatalog, 'crossesOnce');
  assert.equal(kinds(r, 'completed').length, 3);
  assert.ok(r.events.some(e => e.text.startsWith('Read price.read: TWAP 2500') && e.nodeIds.includes('read_market')));
  assert.ok(r.events.some(e => e.text.includes('no model called') && e.nodeIds.includes('explain')));
  assert.equal(kinds(r, 'settled').length, 0);
  assert.equal(r.holdings['paper.USD'], '2500 USD');
});

test('AI-gated purchase buys only on a scripted allow; skip, bad output and timeouts never trade', async () => {
  const p = await program('ai_gated_purchase');
  const allow = await rehearse(p, syntheticCatalog, 'crossesOnce', 'allow');
  assert.equal(kinds(allow, 'settled').length, 3); assert.equal(allow.holdings['paper.USD'], '2425 USD');
  const skip = await rehearse(p, syntheticCatalog, 'crossesOnce', 'skip');
  assert.equal(kinds(skip, 'settled').length, 0); assert.equal(kinds(skip, 'completed').length, 3);
  assert.ok(skip.events.some(e => e.kind === 'command' && e.nodeIds.includes('record_skip')));
  for (const script of ['invalid', 'timeout'] as const) {
    const r = await rehearse(p, syntheticCatalog, 'crossesOnce', script);
    assert.equal(kinds(r, 'settled').length, 0, script); assert.equal(r.holdings['paper.USD'], '2500 USD', script);
    assert.equal(kinds(r, 'failed').length, 3, script);
    assert.ok(kinds(r, 'failed').every(e => e.text.includes('MODEL_OUTPUT_INVALID') && e.nodeIds.includes('gate')), script);
  }
});

test('scheduled pending fills have finite due blocks and an observable reference price',async()=>{
  const r=await rehearse(await program('scheduled_purchase'),syntheticCatalog,'pendingFill');
  assert.equal(r.events.filter(e=>e.kind==='settled').length,3);
  assert.ok(r.ticks.every(t=>t.twap==='2500'));
  assert.ok(r.events.every(e=>e.block<1_000_000));
});
