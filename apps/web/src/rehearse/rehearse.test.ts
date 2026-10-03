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
