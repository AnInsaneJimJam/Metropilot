import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from './threshold-sale.json' with { type: 'json' };
import type { Strategy, Expression, Statement, RunCheckpoint } from '@monad-hack/contracts';
import { compileStrategy, syntheticCatalog, evaluateExpression, transitionPrice, scheduleSlot, startRun, advanceRun, LanguageError } from './index.ts';
import type { CrossingState } from './index.ts';
const source = () => JSON.stringify(fixture);
const copy = () => structuredClone(fixture) as Strategy;
const compile = (value: unknown) => compileStrategy(JSON.stringify(value), syntheticCatalog);
const rejects = async (value: unknown, code: string) => assert.rejects(compile(value), (e: unknown) => e instanceof LanguageError && e.code === code);
const dec = (value: string): Expression => ({ kind: 'literal', valueType: 'Decimal', value });
const bool = (value: boolean): Expression => ({ kind: 'literal', valueType: 'Boolean', value });
const swap = (): Statement => ({ id: 'sale', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD', amount: { kind: 'positionBps', bps: 1000 }, maxSlippageBps: 50 });
const now = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const context = { deploymentRevision: 'paper-test/1', triggerId: 'crossing', sourceEventKey: 'event-1' };

test('normative fixture compiles; key order preserves JCS/hash and behavior changes alter it', async () => {
  const program = await compileStrategy(source(), syntheticCatalog);
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.equal((await compile(reordered)).hash, program.hash);
  assert.match(program.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(program.bounds, { steps: 3, intents: 1, aiCalls: 0 });
  const changed = copy(); changed.name = 'Different revision';
  assert.notEqual((await compile(changed)).hash, program.hash);
  assert.throws(() => { program.strategy.name = 'mutation'; }, TypeError);
  assert.equal(program.canonicalJson, '{"id":"threshold_sale","limits":{"maxActiveSecondsPerRun":60,"maxAiCallsPerRun":1,"maxIntentsPerRun":1,"maxStepsPerRun":100},"name":"Paper threshold partial sale","schemaVersion":"strategy/1","triggers":[{"body":[{"amount":{"bps":1000,"kind":"positionBps"},"connectorRef":"paper.uniswap","id":"sell_tenth","maxSlippageBps":50,"tokenInRef":"paper.WETH","tokenOutRef":"paper.USD","type":"swap.exactInput"},{"id":"record_result","inputs":{},"message":"Threshold sale settled in paper mode.","type":"notify"}],"cooldownSeconds":3600,"feedRef":"paper.weth-usd","id":"crossing","maxAgeSeconds":30,"threshold":{"baseAssetRef":"paper.WETH","decimal":"2500","quoteUnit":"USD"},"type":"price.crossesAbove"}]}');
});

test('imports reject duplicate/escaped keys, malformed Unicode/numbers, cycles and oversized sources', async () => {
  for (const text of ['{"id":"a","id":"b"}', '{"id":"a","\\u0069d":"b"}', '{"x":"\\ud800"}', '{"x":1e999}', '{', '[[]', 'undefined']) {
    await assert.rejects(compileStrategy(text, syntheticCatalog), (e: unknown) => e instanceof LanguageError && e.code === 'SCHEMA_INVALID');
  }
  await assert.rejects(compileStrategy(' '.repeat(256 * 1024 + 1), syntheticCatalog), /256 KiB/);
  await assert.rejects(compileStrategy('['.repeat(65) + '0' + ']'.repeat(65), syntheticCatalog), /nesting/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => JSON.stringify(cyclic), /circular/); // public entry takes JSON text; object graphs cannot bypass it
});

test('closed wire vocabulary, IDs, amounts, versions and references fail before a run', async () => {
  await rejects({ ...fixture, schemaVersion: 'strategy/2' }, 'SCHEMA_INVALID');
  await rejects({ ...fixture, shell: 'rm' }, 'SCHEMA_INVALID');
  const unknown = copy(); unknown.triggers[0]!.body = [{ id: 'bad', type: 'http' } as unknown as Statement]; await rejects(unknown, 'SCHEMA_INVALID');
  const duplicate = copy(); duplicate.triggers[0]!.body[1]!.id = 'sell_tenth'; await rejects(duplicate, 'SCHEMA_INVALID');
  for (const amount of ['0', '-1', '01', (1n << 256n).toString()]) {
    const bad = copy(); const node = bad.triggers[0]!.body[0]!;
    assert.equal(node.type, 'swap.exactInput'); if (node.type === 'swap.exactInput') node.amount = { kind: 'fixed', atomic: amount };
    await assert.rejects(compile(bad), LanguageError);
  }
  const ref = copy(); const node = ref.triggers[0]!.body[0]!;
  if (node.type === 'swap.exactInput') node.tokenInRef = 'attacker.token'; await rejects(ref, 'UNKNOWN_REFERENCE');
  const bps = copy(); const sale = bps.triggers[0]!.body[0]!; if (sale.type === 'swap.exactInput') sale.amount = { kind: 'positionBps', bps: 10001 }; await rejects(bps, 'SCHEMA_INVALID');
  const units = copy(); const price = units.triggers[0]!; if (price.type === 'price.crossesAbove') price.threshold.quoteUnit = 'EUR'; await rejects(units, 'TYPE_MISMATCH');
});

test('exact expression arithmetic, dimensional checks, dust, overflow and short-circuit semantics', async () => {
  assert.deepEqual(evaluateExpression({ kind: 'arithmetic', operator: 'add', left: dec('0.1'), right: dec('0.2') }), dec('0.3'));
  assert.deepEqual(evaluateExpression({ kind: 'arithmetic', operator: 'divide', left: dec('1'), right: dec('8') }), dec('0.125'));
  const money: Expression = { kind: 'literal', valueType: 'Money', value: { assetRef: 'paper.WETH', atomic: '1800000000000000000' } };
  assert.deepEqual(evaluateExpression({ kind: 'arithmetic', operator: 'multiply', left: money, right: dec('0.1') }), { kind: 'literal', valueType: 'Money', value: { assetRef: 'paper.WETH', atomic: '180000000000000000' } });
  assert.throws(() => evaluateExpression({ kind: 'arithmetic', operator: 'divide', left: dec('1'), right: dec('3') }), /represented exactly/);
  assert.throws(() => evaluateExpression({ kind: 'arithmetic', operator: 'subtract', left: money, right: { kind: 'literal', valueType: 'Money', value: { assetRef: 'paper.USD', atomic: '1' } } }), /units/);
  assert.throws(() => evaluateExpression({ kind: 'arithmetic', operator: 'multiply', left: { kind: 'literal', valueType: 'Money', value: { assetRef: 'paper.WETH', atomic: '1' } }, right: dec('0.1') }), /represented exactly/);
  assert.throws(() => evaluateExpression({ kind: 'arithmetic', operator: 'add', left: { kind: 'literal', valueType: 'Integer', value: Number.MAX_SAFE_INTEGER }, right: { kind: 'literal', valueType: 'Integer', value: 1 } }), /overflow/);
  const division: Expression = { kind: 'compare', operator: 'gt', left: { kind: 'arithmetic', operator: 'divide', left: dec('1'), right: dec('0') }, right: dec('0') };
  const condition: Expression = { kind: 'logical', operator: 'and', operands: [bool(false), division] };
  assert.deepEqual(evaluateExpression(condition), bool(false));
  const program = copy(); program.triggers[0]!.body = [{ id: 'branch', type: 'if', condition, then: [swap()], else: [] }];
  const compiled = await compile(program); const done = await advanceRun(compiled, await startRun(compiled, context));
  assert.equal(done.checkpoint.status, 'completed'); assert.equal(done.checkpoint.intents, 0);
  const wrong = copy(); wrong.triggers[0]!.body = [{ id: 'branch', type: 'if', condition: dec('1'), then: [], else: [] }]; await rejects(wrong, 'TYPE_MISMATCH');
  const unbound = copy(); unbound.triggers[0]!.body = [{ id: 'note', type: 'notify', message: 'binding', inputs: { value: { kind: 'ref', name: 'future' } } }]; await rejects(unbound, 'UNKNOWN_REFERENCE');
});

test('crossings honor equality, initial baseline, cooldown, duplicate order, gap reset and stale/future data', async () => {
  const program = await compile(fixture); const trigger = program.strategy.triggers[0]!;
  if (trigger.type !== 'price.crossesAbove') throw new Error('fixture');
  let state: CrossingState = {};
  const feed = (price: string, second: number, currentSecond = second) => {
    const decision = transitionPrice(trigger, state, { sourceEventKey: `event-${second}`, feedRef: trigger.feedRef, price: { ...trigger.threshold, decimal: price }, observedAt: now(second), receivedAt: now(second) }, now(currentSecond));
    state = decision.state; return decision;
  };
  assert.equal(feed('2499', 0).reason, 'baseline');
  assert.equal(feed('2500', 1).fire, false);
  assert.equal(feed('2501', 2).fire, true);
  assert.equal(feed('2502', 3).fire, false);
  const beforeDuplicate = state; assert.equal(feed('2499', 3).reason, 'out-of-order'); assert.deepEqual(state, beforeDuplicate);
  feed('2499', 4); assert.equal(feed('2501', 5).reason, 'cooldown');
  assert.equal(feed('2501', 6).reason, 'no-crossing');
  assert.equal(feed('2499', 40).reason, 'baseline');
  assert.equal(feed('2501', 41, 72).reason, 'stale');
  assert.equal(feed('2502', 73).reason, 'baseline');
  assert.throws(() => feed('2503', 80, 79), /Future/);
  const down = { ...trigger, type: 'price.crossesBelow' } as const;
  const baseline = transitionPrice(down, {}, { sourceEventKey: 'd0', feedRef: trigger.feedRef, price: { ...trigger.threshold, decimal: '2501' }, observedAt: now(0), receivedAt: now(0) }, now(0));
  assert.equal(transitionPrice(down, baseline.state, { sourceEventKey: 'd1', feedRef: trigger.feedRef, price: { ...trigger.threshold, decimal: '2499' }, observedAt: now(1), receivedAt: now(1) }, now(1)).fire, true);
});

test('cooldown expiry boundary and schedule slot coalescing are deterministic', async () => {
  const trigger = (await compile(fixture)).strategy.triggers[0]!;
  if (trigger.type !== 'price.crossesAbove') throw new Error('fixture');
  const state = { baseline: '2499', observedAt: now(3599), sourceEventKey: 'last', acceptedAt: now(0) };
  assert.equal(transitionPrice(trigger, state, { sourceEventKey: 'next', feedRef: trigger.feedRef, price: { ...trigger.threshold, decimal: '2501' }, observedAt: now(3600), receivedAt: now(3600) }, now(3600)).fire, true);
  const schedule = { id: 'timer', type: 'schedule', intervalSeconds: 60, anchorAt: now(60), body: [] } as const;
  assert.equal(scheduleSlot({ ...schedule, body: [] }, now(59)), undefined);
  assert.equal(scheduleSlot({ ...schedule, body: [] }, now(249)), now(240));
  assert.equal(scheduleSlot({ ...schedule, body: [] }, now(249), now(240)), undefined);
});

test('swap suspension, restart, rejection and notifications preserve effect identity', async () => {
  const program = await compile(fixture); const initial = await startRun(program, context);
  const original = await advanceRun(program, initial); assert.equal(original.command?.kind, 'swap.exactInput');
  assert.deepEqual(await advanceRun(program, initial), original); // crash before checkpoint
  assert.deepEqual(await startRun(program, context), initial); // redelivered accepted event
  const saved: RunCheckpoint = JSON.parse(JSON.stringify(original.checkpoint));
  const replay = await advanceRun(program, saved); assert.deepEqual(replay.command, original.command);
  assert.equal(replay.checkpoint.intents, 1);
  const pending = await advanceRun(program, saved, { key: original.command!.key, outcome: 'pending' }); assert.equal(pending.command?.kind, 'swap.exactInput');
  const rejected = await advanceRun(program, saved, { key: original.command!.key, outcome: 'rejected' }); assert.equal(rejected.checkpoint.status, 'failed'); assert.equal(rejected.command, undefined);
  await assert.rejects(advanceRun(program, saved, { key: 'forged', outcome: 'settled' }), /key/);
  await assert.rejects(advanceRun(program, saved, { key: original.command!.key, outcome: 'acknowledged' }), /incompatible/);
  const settled = await advanceRun(program, saved, { key: original.command!.key, outcome: 'settled' }); assert.equal(settled.command?.kind, 'notify');
  const finished = await advanceRun(program, settled.checkpoint, { key: settled.command!.key, outcome: 'acknowledged' });
  assert.equal(finished.checkpoint.status, 'completed'); assert.equal(finished.checkpoint.intents, 1); assert.equal(finished.checkpoint.steps, 3);
  assert.deepEqual((await advanceRun(program, finished.checkpoint)).checkpoint, finished.checkpoint);
});

test('bounded repeats use distinct iteration keys, restore nested frames and obey static limits', async () => {
  const value = copy(); value.limits.maxIntentsPerRun = 3;
  value.triggers[0]!.body = [{ id: 'loop', type: 'repeat', count: 2, body: [swap()] }];
  const program = await compile(value); assert.deepEqual(program.bounds, { steps: 6, intents: 2, aiCalls: 0 });
  const first = await advanceRun(program, await startRun(program, context)); assert.deepEqual(first.command?.iterationPath, [0]);
  const second = await advanceRun(program, JSON.parse(JSON.stringify(first.checkpoint)), { key: first.command!.key, outcome: 'settled' });
  assert.deepEqual(second.command?.iterationPath, [1]); assert.notEqual(first.command!.key, second.command!.key);
  const done = await advanceRun(program, second.checkpoint, { key: second.command!.key, outcome: 'settled' }); assert.equal(done.checkpoint.steps, program.bounds.steps); assert.equal(done.checkpoint.status, 'completed');
  value.limits.maxIntentsPerRun = 1; await rejects(value, 'LIMIT_EXCEEDED');
  value.limits.maxIntentsPerRun = 3; value.limits.maxStepsPerRun = 5; await rejects(value, 'LIMIT_EXCEEDED');
  const nested = copy(); nested.limits.maxIntentsPerRun = 3; nested.triggers[0]!.body = [{ id: 'outer', type: 'repeat', count: 1, body: [{ id: 'inner', type: 'repeat', count: 2, body: [swap()] }] }];
  const nestedProgram = await compile(nested); const step = await advanceRun(nestedProgram, await startRun(nestedProgram, context)); assert.deepEqual(step.command?.iterationPath, [0,0]);
  const bad = copy(); bad.triggers[0]!.body = [{ id: 'r1', type: 'repeat', count: 1, body: [{ id: 'r2', type: 'repeat', count: 1, body: [{ id: 'r3', type: 'repeat', count: 1, body: [] }] }] }]; await rejects(bad, 'LIMIT_EXCEEDED');
});

test('node depth/count bounds and mutually exclusive branches are measured before execution', async () => {
  const branch = copy(); branch.triggers[0]!.body = [{ id: 'gate', type: 'if', condition: bool(true), then: [{ ...swap(), id: 'yes' }], else: [{ ...swap(), id: 'no' }] }];
  assert.equal((await compile(branch)).bounds.intents, 1);
  const huge = copy(); huge.triggers[0]!.body = Array.from({ length: 100 }, (_, i) => ({ id: `note${i}`, type: 'notify', message: 'synthetic', inputs: {} })); await rejects(huge, 'LIMIT_EXCEEDED');
  let body: Statement[] = [];
  for (let i = 0; i < 12; i++) body = [{ id: `branch${i}`, type: 'if', condition: bool(false), then: body, else: [] }];
  const deep = copy(); deep.triggers[0]!.body = body; await rejects(deep, 'LIMIT_EXCEEDED');
});

test('stop and runtime expression errors terminate without later effects; timing excludes waiting', async () => {
  const stopped = copy(); stopped.triggers[0]!.body = [{ id: 'halt', type: 'stop', reason: 'User rule' }, swap()];
  const program = await compile(stopped); const done = await advanceRun(program, await startRun(program, context)); assert.equal(done.checkpoint.status, 'completed'); assert.equal(done.checkpoint.intents, 0);
  const broken = copy(); broken.triggers[0]!.body = [{ id: 'badmath', type: 'notify', message: 'bad division', inputs: { x: { kind: 'arithmetic', operator: 'divide', left: dec('1'), right: dec('0') } } }, swap()];
  const bad = await compile(broken); const failure = await advanceRun(bad, await startRun(bad, context)); assert.equal(failure.checkpoint.status, 'failed'); assert.equal(failure.checkpoint.error?.nodeId, 'badmath'); assert.equal(failure.command, undefined);
  const good = await compile(fixture); const initial = await startRun(good, context); const expired = await advanceRun(good, initial, undefined, 60001); assert.equal(expired.checkpoint.error?.code, 'LIMIT_EXCEEDED');
  const waiting = await advanceRun(good, initial, undefined, 10); const resumed = await advanceRun(good, waiting.checkpoint); assert.equal(resumed.checkpoint.activeMillis, 10);
});

test('checkpoint shape, version, hash, legal nesting and waiting identity are validated', async () => {
  const program = await compile(fixture); const initial = await startRun(program, context);
  for (const invalid of [{ ...initial, schemaVersion: 'run/2' }, { ...initial, strategyHash: 'wrong' }, { ...initial, runId: 'wrong' }, { ...initial, frames: [{ ownerId: 'crossing', branch: 'body', index: 99, iteration: -1 }] }, { ...initial, status: 'waiting' }]) await assert.rejects(advanceRun(program, invalid as RunCheckpoint), LanguageError);
  const pending = await advanceRun(program, initial); const forged = structuredClone(pending.checkpoint); forged.waiting!.nodeId = 'record_result'; await assert.rejects(advanceRun(program, forged), /Waiting command/);
  await assert.rejects(startRun({ ...program }, context), /Compile and validate/);
});

test('read, AI and connector event features fail explicitly until their host/catalog milestone', async () => {
  const read = copy(); read.triggers[0]!.body = [{ id: 'read', type: 'read', connectorRef: 'paper.uniswap', operation: 'price.read', arguments: {}, bind: 'observed' }]; await rejects(read, 'UNSUPPORTED_CAPABILITY');
  const ai = copy(); ai.triggers[0]!.body = [{ id: 'ai', type: 'ai.decide', modelProfileRef: 'paper.model', prompt: 'Evaluate authored condition.', inputs: { price: dec('2500') }, outputSchemaRef: 'decision/1', timeoutSeconds: 10, maxOutputTokens: 100, bind: 'decision' }]; await rejects(ai, 'UNSUPPORTED_CAPABILITY');
  const event = copy(); event.triggers = [{ id: 'event', type: 'connector.event', connectorRef: 'paper.uniswap', eventType: 'swap', filters: {}, body: [] }]; await rejects(event, 'UNSUPPORTED_CAPABILITY');
});

test('checkpoint rejects altered branch choice and schema diagnostics locate the offending node', async () => {
  const value = copy(); value.triggers[0]!.body = [{ id: 'gate', type: 'if', condition: bool(true), then: [{ ...swap(), id: 'allowed' }], else: [{ ...swap(), id: 'skipped' }] }];
  const program = await compile(value); const waiting = await advanceRun(program, await startRun(program, context));
  const altered = structuredClone(waiting.checkpoint); altered.frames[1]!.branch = 'else';
  await assert.rejects(advanceRun(program, altered), /branch disagrees/);
  const bad = copy(); const sale = bad.triggers[0]!.body[0]!; if (sale.type === 'swap.exactInput') sale.amount = { kind: 'positionBps', bps: -1 };
  await assert.rejects(compile(bad), (error: unknown) => error instanceof LanguageError && error.nodeId === 'sell_tenth' && error.fieldPath.includes('/amount/bps'));
});
