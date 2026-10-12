// G4 paper executor scenarios against a real PostgreSQL and the real HTTP boundary
// (docs/specs/executor.md sections 8 and 19; verification V07 and V21). Deployment authority and the
// recorded market are in-memory stand-ins until the control API provides them (G3).
// Skips when DATABASE_URL is unset or unreachable, unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { contentHash, intentKey, validate } from '../packages/contracts/src/index.ts';
import type { ActionIntent, Strategy } from '../packages/contracts/src/index.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';
import { databaseSkip, ExecutorTestHarness } from '../apps/executor/src/testing.ts';
import type { Arranged } from '../apps/executor/src/testing.ts';
import { EXECUTOR_CONFORMANCE_STRATEGY as STRATEGY } from '../apps/runtime/src/conformance/executor.ts';

const skip = await databaseSkip();
const setup = { migrate, seed: seedPaper };
const WETH = 10n ** 18n;

async function intentFor(a: Arranged, overrides: Partial<ActionIntent> = {}): Promise<ActionIntent> {
  const nodeId = overrides.nodeId ?? 'sell_tenth';
  const iterationPath = overrides.iterationPath ?? [];
  const runId = overrides.runId ?? a.runId;
  return {
    schemaVersion: 'action-intent/1', logicalKey: await intentKey({ deploymentId: a.deploymentId, generation: a.generation, runId, nodeId, iterationPath }),
    runId, nodeId, iterationPath, connectorRef: 'paper.uniswap', connectorVersion: '1.0.0', action: 'swap.exactInput', tokenInRef: 'paper.WETH',
    tokenOutRef: 'paper.USD', amount: { kind: 'positionBps', bps: 1000 }, maxSlippageBps: 50, observationRefs: [], ...overrides,
  };
}

const reasonOf = (json: Record<string, unknown>): unknown => (json['details'] as Record<string, unknown> | undefined)?.['reason'];

describe('paper executor (inline dispatch)', { skip }, () => {
  let h: ExecutorTestHarness;
  before(async () => {
    h = await ExecutorTestHarness.start(setup);
  });
  after(async () => {
    await h?.stop();
  });

  test('fills an exact-input intent with exact arithmetic and a deterministic fill ID, never a transaction hash', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const intent = await intentFor(a);
    const { status, json } = await h.post(intent, a.capability());
    assert.equal(status, 201);
    assert.ok(validate('intentResult', json).ok, JSON.stringify(json));
    assert.equal(json['state'], 'settled');
    assert.equal(json['mode'], 'paper');
    assert.equal(json['transactionHash'], undefined);
    assert.equal(json['paperFillId'], await contentHash({ schemaVersion: 'paper-fill/1', logicalKey: intent.logicalKey, adapter: 'paper-adapter/1' }));
    // 10% of 2 WETH at 2500 USD = 500 USD gross; 30 bps fee → 498.5; 5 bps adverse slippage → 498.25075 USD.
    assert.deepEqual(json['settlement'], { inputAtomic: (WETH / 5n).toString(), outputAtomic: '498250750' });
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: (WETH * 9n) / 5n, held: 0n });
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.USD'), { available: 10_000_000_000n + 498_250_750n, held: 0n });
    const { rows } = await h.pool.query<{ type: string; state: string }>(
      `select type, payload ->> 'state' as state from executor_outbox where logical_key = $1 order by id`, [intent.logicalKey]);
    assert.deepEqual(rows.map((r) => `${r.type}:${r.state}`), ['reservation.changed:held', 'transaction.stateChanged:reserved', 'reservation.changed:settled', 'ledger.settled:null', 'transaction.stateChanged:settled']);
  });

  test('duplicate delivery returns the same intent and fill; a changed body with the same key conflicts', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const intent = await intentFor(a);
    const first = await h.post(intent, a.capability());
    const again = await h.post(intent, a.capability());
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, first.json);
    const conflict = await h.post({ ...intent, maxSlippageBps: 40 }, a.capability());
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json['code'], 'IDEMPOTENCY_CONFLICT');
    assert.equal(reasonOf(conflict.json), 'EXECUTOR_INTENT_CONFLICT');
    const fills = await h.pool.query('select 1 from paper_fills where intent_id = $1', [first.json['intentId']]);
    assert.equal(fills.rowCount, 1);
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: (WETH * 9n) / 5n, held: 0n });
  });

  test('concurrent submissions of one intent reserve and fill once', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const intent = await intentFor(a);
    const answers = await Promise.all(Array.from({ length: 6 }, () => h.post(intent, a.capability())));
    assert.equal(new Set(answers.map((r) => r.json['intentId'])).size, 1);
    assert.equal(answers.filter((r) => r.status === 201).length, 1);
    const fills = await h.pool.query('select 1 from paper_fills f join intents i on i.id = f.intent_id where i.logical_key = $1', [intent.logicalKey]);
    assert.equal(fills.rowCount, 1);
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: (WETH * 9n) / 5n, held: 0n });
  });

  test('concurrent different intents cannot overspend the virtual balance', async () => {
    const a = await h.arrange({ strategy: STRATEGY, balances: { 'paper.WETH': 1500n } });
    const intents = await Promise.all([0, 1].map((i) => intentFor(a, { nodeId: 'sell_small', iterationPath: [i], amount: { kind: 'fixed', atomic: '1000' } })));
    // 1000 atomic WETH rounds to zero USD at 2500; a synthetic price keeps the winning fill non-zero.
    h.market.price = 10n ** 15n;
    const [x, y] = await Promise.all(intents.map((intent) => h.post(intent, a.capability()))).finally(() => {
      h.market.price = 2500n;
    });
    assert.deepEqual([x!.json['state'], y!.json['state']].sort(), ['rejected', 'settled']);
    const rejected = [x!, y!].find((r) => r.json['state'] === 'rejected')!;
    assert.equal((rejected.json['reason'] as { code: string }).code, 'EXECUTOR_AMOUNT_EXCEEDED');
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: 500n, held: 0n });
  });

  test('capabilities outside their scope are refused before any effect', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const b = await h.arrange({ strategy: STRATEGY });
    const intent = await intentFor(a);
    const iat = Math.floor(Date.now() / 1000);
    const cases: [string | undefined, number, string][] = [
      [undefined, 401, 'UNAUTHENTICATED'],
      [a.capability().slice(0, -2) + 'AA', 401, 'UNAUTHENTICATED'],
      [a.capability({ iat: iat - 400, exp: iat - 100 }), 401, 'UNAUTHENTICATED'],
      [a.capability({ mode: 'live' }), 403, 'CAPABILITY_DISABLED'],
      [a.capability({ actions: [] }), 403, 'FORBIDDEN'],
      [a.capability({ runId: '0x' + '11'.repeat(32) }), 403, 'FORBIDDEN'],
      [a.capability({ connectors: { 'paper.uniswap': '1.0.1' } }), 403, 'FORBIDDEN'],
      [a.capability({ tenantId: '019a0000-0000-7000-8000-0000000000ff' }), 403, 'FORBIDDEN'],
      // Another deployment's capability: the recomputed key differs from the body's.
      [b.capability({ runId: a.runId }), 409, 'IDEMPOTENCY_CONFLICT'],
    ];
    for (const [capability, status, code] of cases) {
      const answer = await h.post(intent, capability);
      assert.equal(answer.status, status, code);
      assert.equal(answer.json['code'], code);
    }
    const intents = await h.pool.query('select 1 from intents where logical_key = $1', [intent.logicalKey]);
    assert.equal(intents.rowCount, 0);
  });

  test('a stale generation or pause blocks new intents while known intents stay readable', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const known = await intentFor(a);
    const admitted = await h.post(known, a.capability());
    h.authority.set(a.deploymentId, { desiredState: 'paused' });
    const paused = await h.post(await intentFor(a, { nodeId: 'sell_small', iterationPath: [0], amount: { kind: 'fixed', atomic: '1000' } }), a.capability());
    assert.equal(paused.status, 409);
    assert.equal(paused.json['code'], 'GENERATION_REVOKED');
    assert.equal(reasonOf(paused.json), 'EXECUTOR_DEPLOYMENT_INACTIVE');
    const status = await h.get(admitted.json['intentId'] as string, a.capability());
    assert.equal(status.status, 200);
    assert.equal(status.json['state'], 'settled');
    assert.equal((await h.post(known, a.capability())).status, 200);

    h.authority.set(a.deploymentId, { desiredState: 'active', generation: '2' });
    const stale = await h.post(await intentFor(a, { nodeId: 'sell_small', iterationPath: [1], amount: { kind: 'fixed', atomic: '1000' } }), a.capability({ generation: '1' }));
    assert.equal(stale.status, 409);
    assert.equal(reasonOf(stale.json), 'EXECUTOR_STALE_GENERATION');
  });

  test('intents that do not match the approved AST are refused', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const small = { nodeId: 'sell_small', amount: { kind: 'fixed', atomic: '1000' } } as const;
    const forged: Partial<ActionIntent>[] = [
      { nodeId: 'not_in_strategy' },
      { nodeId: 'sell_each' }, // the repeat itself is not an action
      { ...small, iterationPath: [] },
      { ...small, iterationPath: [2] },
      { ...small, iterationPath: [0, 0] },
      { maxSlippageBps: 60 },
      { amount: { kind: 'positionBps', bps: 5000 } },
      { tokenOutRef: 'paper.WETH', tokenInRef: 'paper.USD' },
    ];
    for (const overrides of forged) {
      const answer = await h.post(await intentFor(a, overrides), a.capability());
      assert.equal(answer.status, 422, JSON.stringify(overrides));
      assert.equal(reasonOf(answer.json), 'EXECUTOR_AST_MISMATCH');
    }
    assert.equal((await h.pool.query('select 1 from intents where run_id = $1', [a.runId])).rowCount, 0);
  });

  test('policy denials are durable 201 rejections with stable reasons and no hold', async () => {
    const strict = await h.arrange({ strategy: STRATEGY, policyLimits: { maxSlippageBps: 20, dailyActionCount: 24 } });
    const slippage = await h.post(await intentFor(strict), strict.capability());
    assert.equal(slippage.status, 201);
    assert.deepEqual([slippage.json['state'], (slippage.json['reason'] as { code: string }).code], ['rejected', 'EXECUTOR_SLIPPAGE_EXCEEDED']);
    assert.deepEqual(await h.balance(strict.simulationAccountId, 'paper.WETH'), { available: 2n * WETH, held: 0n });
    const denied = await h.pool.query(`select payload ->> 'reason' as reason from executor_outbox where type = 'policy.denied' and intent_id = $1`, [slippage.json['intentId']]);
    assert.deepEqual(denied.rows, [{ reason: 'EXECUTOR_SLIPPAGE_EXCEEDED' }]);

    const huge = await h.arrange({ strategy: STRATEGY });
    const tooMuch = await h.post(await intentFor(huge, { nodeId: 'sell_too_much', amount: { kind: 'fixed', atomic: '1' + '0'.repeat(40) } }), huge.capability());
    assert.equal((tooMuch.json['reason'] as { code: string }).code, 'EXECUTOR_AMOUNT_EXCEEDED');

    const once = await h.arrange({ strategy: STRATEGY, policyLimits: { maxSlippageBps: 50, dailyActionCount: 1 } });
    assert.equal((await h.post(await intentFor(once), once.capability())).json['state'], 'settled');
    const otherRun = '0x' + '22'.repeat(32);
    const second = await h.post(await intentFor(once, { runId: otherRun }), once.capability({ runId: otherRun }));
    assert.equal((second.json['reason'] as { code: string }).code, 'EXECUTOR_DAILY_LIMIT_EXCEEDED');
  });

  test('missing or stale market data rejects instead of fabricating a fill; unavailable dependencies answer 503', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    try {
      h.market.observedAt = undefined;
      const missing = await h.post(await intentFor(a), a.capability());
      assert.equal((missing.json['reason'] as { code: string }).code, 'EXECUTOR_STALE_OBSERVATION');
      h.market.observedAt = () => new Date(Date.now() - 120_000).toISOString();
      const b = await h.arrange({ strategy: STRATEGY });
      const stale = await h.post(await intentFor(b), b.capability());
      assert.equal((stale.json['reason'] as { code: string }).code, 'EXECUTOR_STALE_OBSERVATION');
      h.market.observedAt = () => new Date().toISOString();

      const c = await h.arrange({ strategy: STRATEGY });
      const intent = await intentFor(c);
      h.market.unavailable = true;
      const down = await h.post(intent, c.capability());
      assert.equal(down.status, 503);
      assert.equal(down.json['retryable'], true);
      h.market.unavailable = false;
      h.authority.unavailable = true;
      assert.equal((await h.post(intent, c.capability())).status, 503);
      h.authority.unavailable = false;
      assert.equal((await h.pool.query('select 1 from intents where logical_key = $1', [intent.logicalKey])).rowCount, 0);
      assert.equal((await h.post(intent, c.capability())).json['state'], 'settled');
    } finally {
      h.market.observedAt = () => new Date().toISOString();
      h.market.unavailable = false;
      h.authority.unavailable = false;
    }
  });

  test('a run cannot exceed the strategy intent limit', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const small = (i: number) => intentFor(a, { nodeId: 'sell_small', iterationPath: [i], amount: { kind: 'fixed', atomic: '1000' } });
    for (const intent of [await intentFor(a), await small(0), await small(1)]) assert.equal((await h.post(intent, a.capability())).status, 201);
    const fourth = await h.post(await intentFor(a, { nodeId: 'sell_too_much', amount: { kind: 'fixed', atomic: '1' + '0'.repeat(40) } }), a.capability());
    assert.equal(fourth.status, 422);
  });

  test('malformed requests are refused at the boundary', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const intent = await intentFor(a);
    const extra = await h.post({ ...intent, recipient: '0x' + '00'.repeat(20) }, a.capability());
    assert.deepEqual([extra.status, extra.json['code'], extra.json['fieldPath']], [400, 'SCHEMA_INVALID', '/recipient']);
    assert.equal((await h.post(intent, a.capability(), { 'idempotency-key': '0x' + '00'.repeat(32) })).status, 400);
    assert.equal((await h.post(intent, a.capability(), { 'content-type': 'text/plain' })).status, 400);
    assert.equal((await h.post(intent, a.capability(), { 'x-request-id': 'not-a-uuid' })).status, 400);
    const big = await h.post(JSON.stringify({ ...intent, pad: 'x'.repeat(20_000) }), a.capability());
    assert.deepEqual([big.status, big.json['code']], [400, 'LIMIT_EXCEEDED']);
    assert.ok(validate('error', big.json).ok);
  });

  test('status is visible only to the same deployment generation and run', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const b = await h.arrange({ strategy: STRATEGY });
    const { json } = await h.post(await intentFor(a), a.capability());
    const id = json['intentId'] as string;
    assert.equal((await h.get(id, a.capability())).status, 200);
    assert.equal((await h.get(id, b.capability())).status, 404);
    assert.equal((await h.get(id, a.capability({ runId: '0x' + '33'.repeat(32) }))).status, 404);
    assert.equal((await h.get('not-an-id', a.capability())).status, 404);
  });

  test('paper fills, verdicts and published outbox rows are immutable', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const { json } = await h.post(await intentFor(a), a.capability());
    const id = json['intentId'] as string;
    await assert.rejects(h.pool.query(`update paper_fills set output_atomic = 1 where intent_id = $1`, [id]), /immutable/);
    await assert.rejects(h.pool.query(`delete from policy_verdicts where intent_id = $1`, [id]), /immutable/);
    await h.pool.query(`update executor_outbox set published_at = now() where intent_id = $1`, [id]);
    await assert.rejects(h.pool.query(`update executor_outbox set published_at = now() where intent_id = $1`, [id]), /append-only/);
    await assert.rejects(h.pool.query(`update executor_outbox set payload = '{}' where intent_id = $1`, [id]), /append-only/);
  });
});

describe('paper executor recovery (deferred dispatch)', { skip }, () => {
  let h: ExecutorTestHarness;
  before(async () => {
    h = await ExecutorTestHarness.start({ ...setup, wiring: { dispatchInline: false } });
  });
  after(async () => {
    await h?.stop();
  });

  test('runtime crash after admission: redelivery returns the same pending intent; recovery fills once', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const intent = await intentFor(a);
    const admitted = await h.post(intent, a.capability());
    assert.deepEqual([admitted.status, admitted.json['state']], [201, 'reserved']);
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: (WETH * 9n) / 5n, held: WETH / 5n });
    const redelivered = await h.post(intent, a.capability());
    assert.deepEqual([redelivered.status, redelivered.json['intentId']], [202, admitted.json['intentId']]);
    // Executor restart: the recovery scan finishes reserved work exactly once, even if it runs twice concurrently.
    const [first, second] = await Promise.all([h.service.reconcile(), h.service.reconcile()]);
    assert.ok(first + second >= 1);
    assert.equal(await h.service.reconcile(), 0);
    const settled = await h.post(intent, a.capability());
    assert.deepEqual([settled.status, settled.json['state']], [200, 'settled']);
    assert.equal((await h.pool.query('select 1 from paper_fills where intent_id = $1', [admitted.json['intentId']])).rowCount, 1);
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: (WETH * 9n) / 5n, held: 0n });
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.USD'), { available: 10_000_000_000n + 498_250_750n, held: 0n });
  });

  test('settlement replay after commit changes nothing', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const { json } = await h.post(await intentFor(a), a.capability());
    const id = json['intentId'] as string;
    const rows = await Promise.all([h.service.dispatch(id), h.service.dispatch(id), h.service.dispatch(id)]);
    assert.ok(rows.every((row) => row.state === 'settled' && row.paperFillId === rows[0]!.paperFillId));
    await h.service.dispatch(id);
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.USD'), { available: 10_000_000_000n + 498_250_750n, held: 0n });
  });

  test('pause between admission and dispatch cancels and releases the hold; status stays queryable', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const { json } = await h.post(await intentFor(a), a.capability());
    h.authority.set(a.deploymentId, { desiredState: 'paused' });
    await h.service.reconcile();
    const status = await h.get(json['intentId'] as string, a.capability());
    assert.equal(status.json['state'], 'cancelled');
    assert.equal((status.json['reason'] as { code: string }).code, 'EXECUTOR_DEPLOYMENT_INACTIVE');
    assert.deepEqual(await h.balance(a.simulationAccountId, 'paper.WETH'), { available: 2n * WETH, held: 0n });
    const reservations = await h.pool.query<{ state: string }>('select state from simulation_reservations where intent_id = $1', [json['intentId']]);
    assert.deepEqual(reservations.rows, [{ state: 'released' }]);
  });

  test('market data unavailable at dispatch leaves the intent reserved until it returns', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const { json } = await h.post(await intentFor(a), a.capability());
    h.market.unavailable = true;
    try {
      await h.service.reconcile();
      assert.equal((await h.get(json['intentId'] as string, a.capability())).json['state'], 'reserved');
    } finally {
      h.market.unavailable = false;
    }
    await h.service.reconcile();
    assert.equal((await h.get(json['intentId'] as string, a.capability())).json['state'], 'settled');
  });
});

describe('paper executor clock ordering', { skip }, () => {
  // Every clock read advances 1 ms, so a quote is always observed after any earlier read.
  // Starts at the real time when the suite begins, not at module load: under a loaded parallel run the gap
  // could exceed the capability's 30 s skew allowance and make a real-time capability "not yet valid".
  let tick = 0;
  const clock = (): Date => new Date((tick += 1));
  let h: ExecutorTestHarness;
  before(async () => {
    tick = Date.now();
    h = await ExecutorTestHarness.start({ ...setup, wiring: { now: clock } });
    h.market.observedAt = () => clock().toISOString();
  });
  after(async () => {
    await h?.stop();
  });

  test('a quote recorded during dispatch is not treated as future-dated', async () => {
    const a = await h.arrange({ strategy: STRATEGY });
    const { json } = await h.post(await intentFor(a), a.capability());
    assert.equal(json['state'], 'settled', JSON.stringify(json['reason']));
  });
});

// Guard: the conformance strategy stays a valid strategy/1 document.
test('executor conformance strategy is a valid strategy/1 document', () => {
  assert.ok(validate('strategy', STRATEGY satisfies Strategy).ok);
});

// Actual broker records and pinned run artifacts, rather than invented checkpoint bindings.
import { brokerHarness } from './broker-harness.ts';
import { createExecutor, PostgresAuthority, PostgresMarketData, signCapability } from '../apps/executor/src/index.ts';
import { verifyCapability } from '../packages/contracts/src/capability.ts';
import { uuidv7 } from '../apps/api/src/runtime-control/store.ts';

describe('executor branch evidence / PostgreSQL', { skip }, () => {
  for (const scenario of ['verified', 'missing', 'contradicting', 'foreign-run'] as const) {
    test(`${scenario} persisted evidence is checked before funds are reserved`, async () => {
      const h = await brokerHarness({ decide: async r => ({ schemaVersion: 'broker-result/1', operationKey: r.operationKey, disposition: 'completed', resultId: uuidv7(), value: { decision: scenario === 'contradicting' ? 'skip' : 'allow', summary: 'Synthetic test decision.' }, receivedAt: new Date().toISOString() }) });
      const request = await h.arrange('ai.decide');
      await h.broker.request(request);
      const claims = verifyCapability(h.tokens.get(request.runId)!, h.secret, Math.floor(Date.now()/1000), 'broker');
      let refs = (await h.pool.query<{ id: string }>('select id from broker_results where run_id=$1 and response->>\'disposition\'=\'completed\' order by id', [request.runId])).rows.map(r => r.id);
      if (scenario === 'missing') refs = refs.slice(0, 1);
      if (scenario === 'foreign-run') {
        const foreign = await h.arrange('ai.decide'); await h.broker.request(foreign);
        refs = (await h.pool.query<{ id: string }>('select id from broker_results where run_id=$1 and response->>\'disposition\'=\'completed\'', [foreign.runId])).rows.map(r => r.id);
      }
      const executor = createExecutor({ pool: h.pool, authority: new PostgresAuthority(h.pool), market: new PostgresMarketData(h.pool, [{ feedRef: 'paper.weth-usd', baseAssetRef: 'paper.WETH', quoteAssetRef: 'paper.USD', baseDecimals: 18, quoteDecimals: 6 }]), capabilitySecret: h.secret, platformLimits: { maxSlippageBps: 100, dailyActionCount: 1000 }, maxQuoteAgeSeconds: 120 });
      const intent: ActionIntent = { schemaVersion: 'action-intent/1', logicalKey: await intentKey({ deploymentId: claims.deploymentId, generation: claims.generation, runId: request.runId, nodeId: 'buy_weth', iterationPath: [] }), runId: request.runId, nodeId: 'buy_weth', iterationPath: [], connectorRef: 'paper.uniswap', connectorVersion: '1.0.0', action: 'swap.exactInput', tokenInRef: 'paper.USD', tokenOutRef: 'paper.WETH', amount: { kind: 'fixed', atomic: '25000000' }, maxSlippageBps: 30, observationRefs: refs };
      const reply = await executor.service.submit({ authorization: `Bearer ${signCapability({ ...claims, aud: 'executor', actions: ['swap.exactInput'] }, h.secret)}`, idempotencyKey: intent.logicalKey, body: JSON.stringify(intent) });
      if (scenario === 'verified') assert.ok('result' in reply, JSON.stringify(reply));
      else {
        assert.ok('failure' in reply, JSON.stringify(reply));
        assert.equal(reply.failure.reason, 'EXECUTOR_AST_MISMATCH');
        assert.equal((await h.pool.query('select 1 from intents')).rowCount, 0);
      }
    });
  }
});
