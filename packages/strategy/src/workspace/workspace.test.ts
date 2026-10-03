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

// ── workspace ↔ strategy conversion (spec check V02) ────────────────────────────────────────────────
import fixture from '../threshold-sale.json' with { type: 'json' };
import type { Strategy } from '@monad-hack/contracts';
import { compileStrategy, compileWorkspace, compileWorkspaceProgram, workspaceFromStrategy, syntheticCatalog, MAX_WORKSPACE_BYTES } from '../index.ts';
type Saved = Record<string, any>;
const catalog = syntheticCatalog;
const strategyOf = (): Strategy => structuredClone(fixture) as Strategy;
const blocksOf = (strategy: Strategy = strategyOf()) => workspaceFromStrategy(strategy, catalog) as { editorFormat: 'blocks/1'; blockly: { blocks: { languageVersion: 0; blocks: Saved[] } } };
const hashOf = async (workspace: unknown) => (await compileWorkspaceProgram(workspace, catalog)).program.hash;
const fixtureHash = async () => (await compileStrategy(JSON.stringify(fixture), catalog)).hash;
const rootOf = (w: ReturnType<typeof blocksOf>) => w.blockly.blocks.blocks[0]!;
const triggerOf = (w: ReturnType<typeof blocksOf>) => rootOf(w).inputs.TRIGGERS.block;
const firstStatement = (w: ReturnType<typeof blocksOf>) => triggerOf(w).inputs.BODY.block;
const rejectsWith = async (workspace: unknown, c: string, blockId?: string) => assert.rejects(compileWorkspaceProgram(workspace, catalog), (e: unknown) => {
  assert.ok(e instanceof LanguageError, String(e)); assert.equal(e.code, c, e.message);
  if (blockId !== undefined) assert.equal(e.nodeId, blockId);
  return true;
});
/** A small expression-heavy statement used to exercise every value block. */
const everyValueBlock = (): Strategy => {
  const s = strategyOf();
  const price = (decimal: string) => ({ kind: 'literal', valueType: 'Price', value: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal } }) as const;
  const b = (value: boolean) => ({ kind: 'literal', valueType: 'Boolean', value }) as const;
  s.triggers[0]!.body.unshift({
    id: 'check', type: 'if',
    condition: { kind: 'logical', operator: 'or', operands: [
      { kind: 'compare', operator: 'gte', left: { kind: 'arithmetic', operator: 'multiply', left: price('2500.5'), right: { kind: 'literal', valueType: 'Decimal', value: '-0.25' } }, right: price('1') },
      { kind: 'logical', operator: 'not', operands: [b(false)] },
      { kind: 'compare', operator: 'eq', left: { kind: 'literal', valueType: 'Enum', value: 'allow' }, right: { kind: 'literal', valueType: 'Enum', value: 'skip' } },
      { kind: 'compare', operator: 'lt', left: { kind: 'literal', valueType: 'Timestamp', value: '2026-01-01T00:00:00.000Z' }, right: { kind: 'literal', valueType: 'Timestamp', value: '2026-01-02T00:00:00.000Z' } },
    ] },
    then: [{ id: 'twice', type: 'repeat', count: 2, body: [{ id: 'note', type: 'notify', message: 'tick', inputs: {
      money: { kind: 'literal', valueType: 'Money', value: { assetRef: 'paper.USD', atomic: '2500500000' } },
      count: { kind: 'literal', valueType: 'Integer', value: -3 },
    } }] }],
    else: [{ id: 'halt', type: 'stop', reason: 'Not now' }],
  });
  return s;
};

test('the normative fixture converts to blocks and back with an identical compileStrategy hash', async () => {
  const workspace = blocksOf();
  assert.equal(workspace.editorFormat, 'blocks/1');
  assert.equal(await hashOf(workspace), await fixtureHash());
  const { strategy, sourceMap } = compileWorkspace(workspace, catalog);
  assert.deepEqual(strategy, fixture);
  assert.deepEqual(sourceMap, { '': 'threshold_sale', '/triggers/0': 'crossing', '/triggers/0/body/0': 'sell_tenth', '/triggers/0/body/1': 'record_result' });
});

test('every block kind round-trips, and the source map names expression blocks too', async () => {
  const original = everyValueBlock();
  const { strategy, sourceMap } = compileWorkspace(blocksOf(original), catalog);
  assert.deepEqual(strategy, original);
  assert.equal(await hashOf(blocksOf(original)), (await compileStrategy(JSON.stringify(original), catalog)).hash);
  for (const pointer of ['/triggers/0/body/0/condition', '/triggers/0/body/0/condition/operands/0/left/right', '/triggers/0/body/0/then/0/body/0/inputs/money'])
    assert.match(sourceMap[pointer] ?? '', /^b[0-9a-z]{10}$/, pointer);
  assert.equal(new Set(Object.values(sourceMap)).size, Object.keys(sourceMap).length);
});

test('save/reload, text form, moving blocks and cosmetic state keep the hash', async () => {
  const expected = await fixtureHash();
  const workspace = blocksOf();
  assert.equal(await hashOf(JSON.stringify(workspace)), expected);
  const moved = structuredClone(workspace); Object.assign(rootOf(moved), { x: 900, y: -40, collapsed: true, deletable: false, inline: true, icons: { comment: { text: 'note' } } });
  assert.equal(await hashOf(moved), expected);
});

test('changing a field changes the hash; human amounts convert exactly', async () => {
  const changed = blocksOf(); triggerOf(changed).fields.THRESHOLD = '2600';
  assert.notEqual(await hashOf(changed), await fixtureHash());
  const fixed = blocksOf(); Object.assign(firstStatement(fixed).fields, { AMOUNT_KIND: 'fixed', AMOUNT: '0.25' });
  const swap = compileWorkspace(fixed, catalog).strategy.triggers[0]!.body[0] as Extract<Strategy['triggers'][0]['body'][0], { type: 'swap.exactInput' }>;
  assert.deepEqual(swap.amount, { kind: 'fixed', atomic: '250000000000000000' });
  Object.assign(firstStatement(fixed).fields, { TOKEN_IN: 'paper.USD', TOKEN_OUT: 'paper.WETH', AMOUNT: '12.000001' });
  assert.deepEqual((compileWorkspace(fixed, catalog).strategy.triggers[0]!.body[0] as typeof swap).amount, { kind: 'fixed', atomic: '12000001' });
  firstStatement(fixed).fields.AMOUNT = '0.0000001';
  await rejectsWith(fixed, 'INVALID_AMOUNT', 'sell_tenth');
});

test('trigger order inside the root is behaviour: reordering changes the hash and the declared order', async () => {
  const s = strategyOf();
  s.triggers.push({ id: 'daily', type: 'schedule', intervalSeconds: 86400, anchorAt: '2026-01-01T00:00:00.000Z', body: [{ id: 'hello', type: 'notify', message: 'daily', inputs: {} }] });
  const swapped = structuredClone(s); swapped.triggers.reverse();
  const a = compileWorkspace(blocksOf(s), catalog).strategy; const b = compileWorkspace(blocksOf(swapped), catalog).strategy;
  assert.deepEqual(a.triggers.map(t => t.id), ['crossing', 'daily']);
  assert.deepEqual(b.triggers.map(t => t.id), ['daily', 'crossing']);
  assert.notEqual(await hashOf(blocksOf(s)), await hashOf(blocksOf(swapped)));
});

test('loose, disabled, unknown, misplaced and malformed blocks are errors on the offending block', async () => {
  const loose = blocksOf(); loose.blockly.blocks.blocks.push({ type: 'notify', id: 'stray', x: 400, y: 0, fields: { MESSAGE: 'x' } });
  await rejectsWith(loose, 'SCHEMA_INVALID', 'stray');
  const disabled = blocksOf(); firstStatement(disabled).enabled = false;
  await rejectsWith(disabled, 'SCHEMA_INVALID', 'sell_tenth');
  const reasons = blocksOf(); firstStatement(reasons).disabledReasons = ['MANUALLY_DISABLED'];
  await rejectsWith(reasons, 'SCHEMA_INVALID', 'sell_tenth');
  const unknown = blocksOf(); firstStatement(unknown).type = 'controls_whileUntil';
  await rejectsWith(unknown, 'UNKNOWN_BLOCK', 'sell_tenth');
  const misplaced = blocksOf(); rootOf(misplaced).inputs.TRIGGERS.block = firstStatement(misplaced);
  await rejectsWith(misplaced, 'SCHEMA_INVALID', 'sell_tenth');
  const extraField = blocksOf(); firstStatement(extraField).fields.SCRIPT = 'alert(1)';
  await rejectsWith(extraField, 'SCHEMA_INVALID', 'sell_tenth');
  const badId = blocksOf(); firstStatement(badId).id = '!#$%';
  await rejectsWith(badId, 'SCHEMA_INVALID');
  const comingSoon = blocksOf(); Object.assign(firstStatement(comingSoon), { type: 'read', fields: { OPERATION: 'price.read', CONNECTOR: 'paper.uniswap', BIND: 'price' } });
  await rejectsWith(comingSoon, 'UNSUPPORTED_CAPABILITY', 'sell_tenth');
  const missingValue = blocksOf(everyValueBlock()); delete firstStatement(missingValue).inputs.CONDITION;
  await rejectsWith(missingValue, 'SCHEMA_INVALID', 'check');
  for (const envelope of [{}, { editorFormat: 'blocks/2', blockly: {} }, { editorFormat: 'blocks/1', blockly: { blocks: { languageVersion: 0, blocks: [] } } }, '{"editorFormat":']) await rejectsWith(envelope, 'SCHEMA_INVALID');
});

test('empty trigger bodies, a 100% MON sale and oversized workspaces fail', async () => {
  const empty = blocksOf(); delete triggerOf(empty).inputs;
  await rejectsWith(empty, 'SCHEMA_INVALID', 'crossing');
  const allMon = blocksOf(); Object.assign(firstStatement(allMon).fields, { TOKEN_IN: 'paper.MON', AMOUNT: '100' });
  await rejectsWith(allMon, 'POLICY_DENIED', 'sell_tenth');
  const huge = blocksOf(); rootOf(huge).data = 'x'.repeat(MAX_WORKSPACE_BYTES);
  await rejectsWith(huge, 'LIMIT_EXCEEDED');
  await rejectsWith(JSON.stringify(huge), 'LIMIT_EXCEEDED');
});

test('compiler errors are mapped back to the block to highlight', async () => {
  const s = everyValueBlock();
  const workspace = blocksOf(s);
  const compare = firstStatement(workspace).inputs.CONDITION.block.inputs.OPERAND0.block;
  compare.inputs.RIGHT.block = { type: 'literal.Integer', id: 'bwrongtype1', fields: { VALUE: 1 } };
  await rejectsWith(workspace, 'TYPE_MISMATCH', 'check'); // the statement owning the bad expression
  const limits = blocksOf(); rootOf(limits).fields.MAX_STEPS = 5000;
  await rejectsWith(limits, 'SCHEMA_INVALID', 'threshold_sale');
});
