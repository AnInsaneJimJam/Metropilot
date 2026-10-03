import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toAtomic, fromAtomic, normalizeHuman, toPriceDecimal, toLanguageDecimal, percentToBps, bpsToPercent, newNodeId, NODE_ID, priceUnitKey, parsePriceUnitKey, LanguageError } from '../index.ts';
const code = (c: string) => (e: unknown) => e instanceof LanguageError && e.code === c;

test('human units convert exactly for 18 and 6 decimals and round-trip', () => {
  assert.equal(toAtomic('0.25', 18), '250000000000000000');
  assert.equal(toAtomic('1', 18), '1000000000000000000');
  assert.equal(toAtomic('0.000000000000000001', 18), '1');
  assert.equal(toAtomic('2500.5', 6), '2500500000');
  assert.equal(toAtomic('0010.500', 6), '10500000');
  for (const [human, decimals] of [['0.25', 18], ['123456789.123456789123456789', 18], ['2500.5', 6], ['0', 6], ['0.000001', 6]] as const) {
    assert.equal(fromAtomic(toAtomic(human, decimals), decimals), normalizeHuman(human));
  }
});

test('too many decimals, malformed text and overflow are errors, never rounded', () => {
  assert.throws(() => toAtomic('0.0000001', 6), code('INVALID_AMOUNT'));
  assert.throws(() => toAtomic('0.0000000000000000001', 18), code('INVALID_AMOUNT'));
  for (const bad of ['', '-1', '1e3', '.5', '1.', '0x10', ' 1 2', 'NaN']) assert.throws(() => toAtomic(bad, 18), code('INVALID_AMOUNT'), bad);
  assert.throws(() => toAtomic('9'.repeat(78), 18), code('INVALID_AMOUNT'));
  assert.equal(toPriceDecimal('2500.10'), '2500.1');
  assert.throws(() => toPriceDecimal('0'), code('TYPE_MISMATCH'));
  assert.equal(toLanguageDecimal('-0.50'), '-0.5');
  assert.equal(toLanguageDecimal('-0'), '0');
  assert.throws(() => toLanguageDecimal('1.' + '1'.repeat(19)), code('TYPE_MISMATCH'));
  assert.throws(() => toPriceDecimal('1.' + '1'.repeat(19)), code('TYPE_MISMATCH'));
});

test('percentages map exactly to basis points', () => {
  assert.equal(percentToBps('10'), 1000);
  assert.equal(percentToBps('0.01'), 1);
  assert.equal(percentToBps('100'), 10000);
  assert.equal(bpsToPercent(1000), '10');
  assert.equal(bpsToPercent(1), '0.01');
  assert.equal(bpsToPercent(1250), '12.5');
  for (const bad of ['0', '0.001', '100.01', '101']) assert.throws(() => percentToBps(bad), code('INVALID_AMOUNT'), bad);
});

test('editor IDs match the node grammar and price unit keys round-trip', () => {
  const ids = new Set(Array.from({ length: 200 }, newNodeId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, NODE_ID), assert.match(id, /^b[0-9a-z]{10}$/);
  assert.deepEqual(parsePriceUnitKey(priceUnitKey('paper.WETH', 'USD')), { baseAssetRef: 'paper.WETH', quoteUnit: 'USD' });
  assert.equal(parsePriceUnitKey('paper.WETH'), undefined);
});
