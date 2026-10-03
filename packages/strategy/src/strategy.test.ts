import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from './threshold-sale.json' with { type: 'json' };
import type { Strategy, Expression, Statement, RunCheckpoint } from '@monad-hack/contracts';
import { compileStrategy, syntheticCatalog, evaluateExpression, transitionPrice, scheduleSlot, startRun, advanceRun, LanguageError, PRESETS } from './index.ts';
import type { CrossingState, CompiledStrategy, HostResponse, AdvanceResult } from './index.ts';
const source = () => JSON.stringify(fixture);
const copy = () => structuredClone(fixture) as Strategy;
const compile = (value: unknown) => compileStrategy(JSON.stringify(value), syntheticCatalog);
const rejects = async (value: unknown, code: string) => assert.rejects(compile(value), (e: unknown) => e instanceof LanguageError && e.code === code);
const dec = (value: string): Expression => ({ kind: 'literal', valueType: 'Decimal', value });
const bool = (value: boolean): Expression => ({ kind: 'literal', valueType: 'Boolean', value });
const swap = (): Extract<Statement, { type: 'swap.exactInput' }> => ({ id: 'sale', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD', amount: { kind: 'positionBps', bps: 1000 }, maxSlippageBps: 50 });
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

test('connector event triggers still fail explicitly until their catalog milestone', async () => {
  const event = copy(); event.triggers = [{ id: 'event', type: 'connector.event', connectorRef: 'paper.uniswap', eventType: 'swap', filters: {}, body: [{ id: 'note', type: 'notify', message: 'event', inputs: {} }] }]; await rejects(event, 'UNSUPPORTED_CAPABILITY');
});

test('checkpoint rejects altered branch choice and schema diagnostics locate the offending node', async () => {
  const value = copy(); value.triggers[0]!.body = [{ id: 'gate', type: 'if', condition: bool(true), then: [{ ...swap(), id: 'allowed' }], else: [{ ...swap(), id: 'skipped' }] }];
  const program = await compile(value); const waiting = await advanceRun(program, await startRun(program, context));
  const altered = structuredClone(waiting.checkpoint); altered.frames[1]!.branch = 'else';
  await assert.rejects(advanceRun(program, altered), /branch disagrees/);
  const bad = copy(); const sale = bad.triggers[0]!.body[0]!; if (sale.type === 'swap.exactInput') sale.amount = { kind: 'positionBps', bps: -1 };
  await assert.rejects(compile(bad), (error: unknown) => error instanceof LanguageError && error.nodeId === 'sell_tenth' && error.fieldPath.includes('/amount/bps'));
});

test('editor catalog declares decimals, native MON, both paper venues and finalized TWAP feeds', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(syntheticCatalog.assets).map(([ref, a]) => [ref, [a.decimals, a.native ?? false]])), { 'paper.MON': [18, true], 'paper.WETH': [18, false], 'paper.USD': [6, false] });
  assert.deepEqual(Object.values(syntheticCatalog.connectors).map(c => [c.venue, c.actions]), [['uniswap-v3', ['swap.exactInput', 'price.read']], ['kuru', ['swap.exactInput', 'price.read']]]);
  for (const feed of Object.values(syntheticCatalog.feeds)) { assert.equal(feed.source, 'poolTwap'); assert.equal(feed.windowSeconds, 30); assert.equal(feed.finality, 'finalized'); assert.ok(Object.hasOwn(syntheticCatalog.connectors, feed.connectorRef)); }
  assert.throws(() => { (syntheticCatalog.assets['paper.MON'] as { decimals: number }).decimals = 6; }, TypeError);
  const kuru = copy(); const trigger = kuru.triggers[0]!; const sale = trigger.body[0]!;
  if (trigger.type === 'price.crossesAbove') trigger.feedRef = 'paper.weth-usd-kuru';
  if (sale.type === 'swap.exactInput') sale.connectorRef = 'paper.kuru';
  assert.equal((await compile(kuru)).bounds.intents, 1);
});

test('schedule floor is 10 s and trigger bodies need at least one statement', async () => {
  const timer = (intervalSeconds: number) => ({ ...fixture, triggers: [{ id: 'timer', type: 'schedule', intervalSeconds, anchorAt: now(0), body: [swap()] }] });
  assert.equal((await compile(timer(10))).strategy.triggers[0]!.type, 'schedule');
  await rejects(timer(9), 'SCHEMA_INVALID');
  const empty = copy(); empty.triggers[0]!.body = [];
  await assert.rejects(compile(empty), (e: unknown) => e instanceof LanguageError && e.code === 'SCHEMA_INVALID' && e.nodeId === 'crossing' && e.fieldPath.endsWith('/body'));
  await rejects({ ...timer(60), triggers: [{ ...timer(60).triggers[0]!, body: [] }] }, 'SCHEMA_INVALID');
});

test('native MON gas guard rejects a 100% position sale but allows partial or non-native sales', async () => {
  const sale = (tokenInRef: string, tokenOutRef: string, bps: number) => { const value = copy(); value.triggers[0]!.body[0] = { ...swap(), tokenInRef, tokenOutRef, amount: { kind: 'positionBps', bps } }; return value; };
  await assert.rejects(compile(sale('paper.MON', 'paper.USD', 10000)), (e: unknown) => e instanceof LanguageError && e.code === 'POLICY_DENIED' && e.nodeId === 'sale');
  assert.equal((await compile(sale('paper.MON', 'paper.USD', 9999))).bounds.intents, 1);
  assert.equal((await compile(sale('paper.WETH', 'paper.USD', 10000))).bounds.intents, 1);
  const fixedMon = copy(); fixedMon.triggers[0]!.body[0] = { ...swap(), tokenInRef: 'paper.MON', amount: { kind: 'fixed', atomic: '1000000000000000000' } };
  assert.equal((await compile(fixedMon)).bounds.intents, 1);
});

// ── named values, read and ai.decide (editor plan Phase 8) ─────────────────────────────────────────
const field = (name: string, f: string): Expression => ({ kind: 'field', name, field: f });
const read = (id = 'look', bind = 'market'): Statement => ({ id, type: 'read', connectorRef: 'paper.uniswap', operation: 'price.read', arguments: {}, bind });
const ai = (id = 'ask', bind = 'gate', inputs: Record<string, Expression> = { price: field('market', 'price') }): Extract<Statement, { type: 'ai.decide' }> =>
  ({ id, type: 'ai.decide', modelProfileRef: 'paper.kimi', prompt: 'Allow or skip?', inputs, outputSchemaRef: 'decision/1', timeoutSeconds: 20, maxOutputTokens: 256, bind });
const note = (id: string, inputs: Record<string, Expression> = {}): Statement => ({ id, type: 'notify', message: id, inputs });
const withBody = (...body: Statement[]) => { const value = copy(); value.triggers[0]!.body = body; return value; };
const gated = () => structuredClone(PRESETS.find(p => p.id === 'ai_gated_purchase')!.strategy);
const gatedContext = { deploymentRevision: 'paper-test/1', triggerId: 'daily', sourceEventKey: 'slot-1' };
const observation = (decimal = '2501', observedAt = now(0)) => ({ price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal }, observedAt });
const recorded = (step: AdvanceResult, result: unknown, receivedAt?: string): HostResponse => ({ key: step.command!.key, outcome: 'recorded', result, ...(receivedAt ? { receivedAt } : {}) });
/** Runs the AI-gated preset: read (fresh, at t+5 s) → the given AI answer → whatever follows. */
async function gate(program: CompiledStrategy, answer: unknown) {
  const reading = await advanceRun(program, await startRun(program, gatedContext));
  const asking = await advanceRun(program, reading.checkpoint, recorded(reading, observation(), now(5)));
  return { reading, asking, decided: await advanceRun(program, asking.checkpoint, recorded(asking, answer)) };
}

test('read and ai.decide compile with typed fields, counted AI calls and catalog-checked models', async () => {
  const program = await compile(gated());
  assert.deepEqual(program.bounds, { steps: 12, intents: 1, aiCalls: 1 });
  assert.deepEqual(Object.keys(program.bindings), ['read_market', 'gate']);
  assert.equal(program.bindings.read_market!.maxAgeSeconds, 30);
  await rejects(withBody(read('a'), ai('one', 'g1'), ai('two', 'g2')), 'LIMIT_EXCEEDED'); // 2 AI calls, limit 1
  const twice = withBody(read('a'), { id: 'loop', type: 'repeat', count: 2, body: [ai()] }); twice.limits.maxAiCallsPerRun = 3;
  assert.equal((await compile(twice)).bounds.aiCalls, 2);
  const either = withBody(read('a'), { id: 'pick', type: 'if', condition: bool(true), then: [ai('yes', 'g1')], else: [ai('no', 'g2')] });
  assert.equal((await compile(either)).bounds.aiCalls, 1);
  await rejects(withBody(read('a'), { ...ai(), modelProfileRef: 'paper.unknown' }), 'UNKNOWN_REFERENCE');
  await rejects(withBody(read('a'), { ...ai(), timeoutSeconds: 31 }), 'LIMIT_EXCEEDED');
  await rejects(withBody(read('a'), { ...ai(), maxOutputTokens: 2000 }), 'LIMIT_EXCEEDED');
  await rejects(withBody({ ...read(), operation: 'balance.read' } as Statement), 'UNSUPPORTED_CAPABILITY');
  await rejects(withBody({ ...read(), connectorRef: 'paper.unknown' } as Statement), 'UNKNOWN_REFERENCE');
  await rejects(withBody({ ...read(), arguments: { pool: dec('1') } } as Statement), 'SCHEMA_INVALID');
});

test('named values are lexical: in order, no escape from branches, no duplicates or shadowing, fields only', async () => {
  const price = field('market', 'price');
  const above = (left: Expression): Expression => ({ kind: 'compare', operator: 'gt', left, right: { kind: 'literal', valueType: 'Price', value: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: '2500' } } });
  assert.equal((await compile(withBody(read(), { id: 'cmp', type: 'if', condition: above(price), then: [note('hi', { price })], else: [] }))).bounds.aiCalls, 0);
  await assert.rejects(compile(withBody(note('early', { price }), read())), (e: unknown) => e instanceof LanguageError && e.code === 'UNKNOWN_REFERENCE' && e.nodeId === 'early');
  await rejects(withBody({ id: 'branch', type: 'if', condition: bool(true), then: [read()], else: [] }, note('after', { price })), 'UNKNOWN_REFERENCE');
  await rejects(withBody({ id: 'loop', type: 'repeat', count: 2, body: [read()] }, note('after', { price })), 'UNKNOWN_REFERENCE');
  await assert.rejects(compile(withBody(read('a'), read('b'))), (e: unknown) => e instanceof LanguageError && e.code === 'SCHEMA_INVALID' && e.nodeId === 'b' && e.fieldPath === '/nodes/b/bind');
  await rejects(withBody(read('a'), { id: 'branch', type: 'if', condition: bool(true), then: [read('b')], else: [] }), 'SCHEMA_INVALID'); // shadowing
  assert.equal((await compile(withBody({ id: 'branch', type: 'if', condition: bool(true), then: [read('a')], else: [read('b')] }))).bounds.intents, 0); // sibling scopes
  await rejects(withBody(read(), note('whole', { market: { kind: 'ref', name: 'market' } })), 'TYPE_MISMATCH');
  await rejects(withBody(read(), note('typo', { p: field('market', 'prize') })), 'UNKNOWN_REFERENCE');
  await rejects(withBody(read(), { id: 'cmp', type: 'if', condition: above(field('market', 'observedAt')), then: [], else: [] }), 'TYPE_MISMATCH');
  const textCompare: Expression = { kind: 'compare', operator: 'eq', left: field('gate', 'summary'), right: field('gate', 'summary') };
  await rejects(withBody(read(), ai(), { id: 'cmp', type: 'if', condition: textCompare, then: [], else: [] }), 'TYPE_MISMATCH');
});

test('AI-gated run: read, decide allow → one intent; skip → no intent; replay reuses recorded results', async () => {
  const program = await compile(gated());
  const allow = await gate(program, { decision: 'allow', summary: 'Fits the plan.' });
  assert.equal(allow.reading.command?.kind, 'read'); assert.equal(allow.reading.checkpoint.waiting?.kind, 'read');
  assert.equal(allow.asking.command?.kind, 'ai.decide');
  if (allow.asking.command?.kind !== 'ai.decide') throw new Error('expected AI command');
  assert.deepEqual(allow.asking.command.inputs.price, { kind: 'literal', valueType: 'Price', value: observation().price });
  assert.equal(allow.asking.checkpoint.aiCalls, 1);
  assert.equal(allow.decided.command?.kind, 'swap.exactInput'); assert.equal(allow.decided.checkpoint.intents, 1);
  const settled = await advanceRun(program, allow.decided.checkpoint, { key: allow.decided.command!.key, outcome: 'settled' });
  if (settled.command?.kind !== 'notify') throw new Error('expected notify');
  assert.deepEqual(settled.command.inputs.reason, { kind: 'literal', valueType: 'Text', value: 'Fits the plan.' });
  const skip = await gate(program, { decision: 'skip', summary: 'Unsure.' });
  assert.equal(skip.decided.command?.kind, 'notify'); assert.equal(skip.decided.command?.nodeId, 'record_skip'); assert.equal(skip.decided.checkpoint.intents, 0);
  // Replay: the same checkpoints and recorded responses give identical results, also after a JSON save/reload.
  assert.deepEqual(await gate(program, { decision: 'allow', summary: 'Fits the plan.' }), allow);
  const reloaded: RunCheckpoint = JSON.parse(JSON.stringify(allow.asking.checkpoint));
  assert.deepEqual(await advanceRun(program, reloaded, recorded(allow.asking, { summary: 'Fits the plan.', decision: 'allow' })), allow.decided);
});

test('stale, future or missing reads and invalid, timed-out or refused AI output stop the run with no intents', async () => {
  const program = await compile(gated());
  const reading = await advanceRun(program, await startRun(program, gatedContext));
  const stopped = async (response: HostResponse, code: string, nodeId: string, from = reading) => {
    const result = await advanceRun(program, from.checkpoint, response);
    assert.equal(result.checkpoint.status, 'failed'); assert.equal(result.checkpoint.error?.code, code); assert.equal(result.checkpoint.error?.nodeId, nodeId);
    assert.equal(result.command, undefined); assert.equal(result.checkpoint.intents, 0); assert.deepEqual(result.checkpoint.bindings, []);
  };
  await stopped(recorded(reading, observation('2501', now(0)), now(31)), 'STALE_DATA', 'read_market');
  assert.equal((await advanceRun(program, reading.checkpoint, recorded(reading, observation('2501', now(0)), now(30)))).command?.kind, 'ai.decide'); // exactly at the limit is fresh
  await stopped(recorded(reading, observation('2501', now(10)), now(5)), 'STALE_DATA', 'read_market');
  await stopped({ key: reading.command!.key, outcome: 'failed' }, 'STALE_DATA', 'read_market');
  await stopped(recorded(reading, { price: { baseAssetRef: 'paper.WETH', quoteUnit: 'EUR', decimal: '1' }, observedAt: now(0) }, now(1)), 'STALE_DATA', 'read_market');
  await stopped(recorded(reading, { ...observation(), extra: 1 }, now(1)), 'STALE_DATA', 'read_market');
  await assert.rejects(advanceRun(program, reading.checkpoint, recorded(reading, observation())), /receivedAt/);
  const asking = await advanceRun(program, reading.checkpoint, recorded(reading, observation(), now(5)));
  for (const bad of [{ decision: 'buy', summary: 'x' }, { decision: 'allow' }, { decision: 'allow', summary: '' }, { decision: 'allow', summary: 'x'.repeat(501) }, { decision: 'allow', summary: 'x', size: 10 }, 'allow', null]) {
    await stopped(recorded(asking, bad), 'MODEL_OUTPUT_INVALID', 'gate', asking);
  }
  await stopped({ key: asking.command!.key, outcome: 'timeout' }, 'MODEL_OUTPUT_INVALID', 'gate', asking);
  await stopped({ key: asking.command!.key, outcome: 'refused' }, 'MODEL_OUTPUT_INVALID', 'gate', asking);
  await stopped({ key: asking.command!.key, outcome: 'failed' }, 'MODEL_UNAVAILABLE', 'gate', asking);
  await assert.rejects(advanceRun(program, asking.checkpoint, { key: asking.command!.key, outcome: 'settled' }), /incompatible/);
});

test('checkpoints keep only in-scope bindings, reset them per repeat iteration and reject forged values', async () => {
  const looped = withBody({ id: 'loop', type: 'repeat', count: 2, body: [read(), note('seen', { price: field('market', 'price') })] }, note('done'));
  const program = await compile(looped);
  const first = await advanceRun(program, await startRun(program, context));
  const told = await advanceRun(program, first.checkpoint, recorded(first, observation('2501'), now(1)));
  assert.equal(told.checkpoint.bindings.length, 1); assert.deepEqual(told.checkpoint.bindings[0]!.iterationPath, [0]);
  const second = await advanceRun(program, told.checkpoint, { key: told.command!.key, outcome: 'acknowledged' });
  assert.equal(second.command?.kind, 'read'); assert.deepEqual(second.command?.iterationPath, [1]);
  assert.deepEqual(second.checkpoint.bindings, []); // iteration 0's value is out of scope in iteration 1
  const told2 = await advanceRun(program, second.checkpoint, recorded(second, observation('2600'), now(2)));
  if (told2.command?.kind !== 'notify') throw new Error('expected notify');
  assert.equal(told2.command.inputs.price!.valueType === 'Price' && told2.command.inputs.price!.value.decimal, '2600');
  const after = await advanceRun(program, told2.checkpoint, { key: told2.command.key, outcome: 'acknowledged' });
  assert.equal(after.command?.nodeId, 'done'); assert.deepEqual(after.checkpoint.bindings, []);
  const forged = structuredClone(told.checkpoint); (forged.bindings[0]!.value.price as { value: { decimal: string } }).value.decimal = '0'; // schema-shaped, but not a positive price
  await assert.rejects(advanceRun(program, forged), /binding value/);
  const renamed = structuredClone(told.checkpoint); renamed.bindings[0]!.name = 'other';
  await assert.rejects(advanceRun(program, renamed), /binding/);
  const extra = structuredClone(told.checkpoint); extra.bindings.push({ ...extra.bindings[0]!, iterationPath: [1] });
  await assert.rejects(advanceRun(program, extra), /in scope/);
  const overspent = structuredClone(told.checkpoint); overspent.aiCalls = 2;
  await assert.rejects(advanceRun(program, overspent), /counters/);
});
