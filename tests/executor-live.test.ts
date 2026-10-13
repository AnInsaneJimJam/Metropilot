// Live intents on the funds ledger through the real executor HTTP boundary and PostgreSQL (executor.md sections 5,
// 7, 9 and 13; funds-and-budgets.md section 4; verification V09). The deployment authority is the harness's
// in-memory stand-in; catalog rows, wallet and funds are labelled test data. No chain or signer is involved:
// the signing pipeline (#39–#41) calls the transitions exercised here.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { contentHash, intentKey, validate } from '../packages/contracts/src/index.ts';
import type { ActionIntent, Strategy } from '../packages/contracts/src/index.ts';
import { agentBalances, allocate, depositPostings, freeze, postJournal, user } from '../packages/accounting/src/index.ts';
import type { AgentScope } from '../packages/accounting/src/index.ts';
import { evaluateAction } from '../packages/policy/src/index.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';
import { LiveIntents } from '../apps/executor/src/live.ts';
import type { LiveConfig } from '../apps/executor/src/live.ts';
import { databaseSkip, ExecutorTestHarness } from '../apps/executor/src/testing.ts';
import type { Arranged } from '../apps/executor/src/testing.ts';
import { uuidv7 } from '../apps/executor/src/ids.ts';

const skip = await databaseSkip();
const NETWORK = 'live-test';
const CHAIN = 31_337;
const WETH = 10n ** 18n;
const GAS_CEILING = 10n ** 15n;

const STRATEGY: Strategy = {
  schemaVersion: 'strategy/1', id: 'live_sell', name: 'Live sell (test)',
  triggers: [{
    id: 'hourly', type: 'schedule', intervalSeconds: 3600, anchorAt: '2026-10-01T00:00:00.000Z',
    body: [
      { id: 'sell_tenth', type: 'swap.exactInput', connectorRef: 'live.uniswap', tokenInRef: 'live.WETH', tokenOutRef: 'live.USD', amount: { kind: 'positionBps', bps: 1000 }, maxSlippageBps: 50 },
      { id: 'sell_each', type: 'repeat', count: 2, body: [
        { id: 'sell_fixed', type: 'swap.exactInput', connectorRef: 'live.uniswap', tokenInRef: 'live.WETH', tokenOutRef: 'live.USD', amount: { kind: 'fixed', atomic: (6n * WETH / 10n).toString() }, maxSlippageBps: 50 },
      ] },
    ],
  }],
  limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 3, maxActiveSecondsPerRun: 60 },
};

const live: LiveConfig = {
  chainId: CHAIN, networkRef: NETWORK, gasAssetRef: 'live.MON', gasCeilingAtomic: GAS_CEILING, holdSeconds: 120, maxValuationAgeSeconds: 60,
  platformLimits: { allowedChainIds: [CHAIN], maxInputAtomic: 10n * WETH, dailyActionCount: 10, dailyNotionalUsdMicros: 10_000_000_000n, maxSlippageBps: 100 },
  valuation: { usdMicrosPerToken: async (ref) => (ref === 'live.WETH' ? { usdMicros: 2_500_000_000n, decimals: 18, observedAt: new Date().toISOString() } : undefined) },
};

describe('live executor intents on the funds ledger', { skip }, () => {
  let h: ExecutorTestHarness;
  let intents: LiveIntents;
  before(async () => {
    h = await ExecutorTestHarness.start({ migrate, seed: seedPaper, wiring: { live } });
    intents = new LiveIntents(h.pool, live);
    // Labelled test catalog for the live network: one connector and three on-chain assets (fake addresses).
    const rows: [string, string, Record<string, unknown>][] = [
      ['connector', 'live.uniswap', { networkRef: NETWORK, capabilities: ['swap.exactInput'] }],
      ['asset', 'live.WETH', { identity: { kind: 'erc20', networkRef: NETWORK, chainId: CHAIN, contractAddress: '0x00000000000000000000000000000000000000e1' }, decimals: 18 }],
      ['asset', 'live.USD', { identity: { kind: 'erc20', networkRef: NETWORK, chainId: CHAIN, contractAddress: '0x00000000000000000000000000000000000000e2' }, decimals: 6 }],
      ['asset', 'live.MON', { identity: { kind: 'native', networkRef: NETWORK, chainId: CHAIN }, decimals: 18 }],
    ];
    for (const [kind, ref, definition] of rows) {
      await h.pool.query(`insert into catalog_versions (kind, ref, version, modes, content_hash, definition) values ($1, $2, '1.0.0', '{live}', $3, $4)`, [kind, ref, await contentHash(definition), definition]);
    }
  });
  after(async () => {
    await h?.stop();
  });

  async function arrangeLive(weth = 2n * WETH, mon = 10n ** 16n): Promise<Arranged & { scope: AgentScope; liveCapability: () => string }> {
    const a = await h.arrange({ strategy: STRATEGY, policyLimits: { maxSlippageBps: 50, dailyActionCount: 24 } });
    await h.pool.query(`update deployments set mode = 'live', simulation_account_id = null, network_ref = $2, connector_versions = $3 where id = $1`, [a.deploymentId, NETWORK, { 'live.uniswap': '1.0.0' }]);
    h.authority.set(a.deploymentId, { mode: 'live', networkRef: NETWORK, connectorPins: { 'live.uniswap': '1.0.0' } });
    const { simulationAccountId: _ignored, ...rest } = h.authority.deployments.get(a.deploymentId)!;
    h.authority.deployments.set(a.deploymentId, rest);
    await h.pool.query(`insert into wallets (tenant_id, id, agent_id, network_ref, chain_id, provider, provider_wallet_id, address, status, created_at)
      values ($1, $2, $3, $4, $5, 'local', $6, $7, 'active', now())`, [a.tenantId, uuidv7(), a.agentId, NETWORK, CHAIN, `local-${a.agentId}`, `0x${a.agentId.replace(/-/g, '').slice(0, 32).padEnd(40, '0')}`]);
    const scope: AgentScope = { mode: 'live', tenantId: a.tenantId, agentId: a.agentId };
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      for (const [asset, amount] of [['live.WETH', weth], ['live.MON', mon]] as const) {
        await postJournal(c, { operationKey: `fund:${a.agentId}:${asset}`, mode: 'live', tenantId: a.tenantId, agentId: a.agentId, kind: 'deposit', postings: depositPostings(scope, asset, amount), occurredAt: new Date() });
        const v = (await c.query<{ budget_version: number }>('select budget_version from agents where id = $1', [a.agentId])).rows[0]!.budget_version;
        await allocate(c, { scope, assetRef: asset, expectedBudgetVersion: v, targets: { trading: amount }, actor: 'test', now: new Date() });
      }
      await c.query('commit');
    } finally {
      c.release();
    }
    return { ...a, scope, liveCapability: () => a.capability({ mode: 'live', connectors: { 'live.uniswap': '1.0.0' } }) };
  }

  const intentFor = async (a: Arranged, nodeId = 'sell_tenth', iterationPath: number[] = []): Promise<ActionIntent> => {
    const node = nodeId === 'sell_tenth' ? { amount: { kind: 'positionBps' as const, bps: 1000 } } : { amount: { kind: 'fixed' as const, atomic: (6n * WETH / 10n).toString() } };
    return {
      schemaVersion: 'action-intent/1', logicalKey: await intentKey({ deploymentId: a.deploymentId, generation: a.generation, runId: a.runId, nodeId, iterationPath }),
      runId: a.runId, nodeId, iterationPath, connectorRef: 'live.uniswap', connectorVersion: '1.0.0', action: 'swap.exactInput', tokenInRef: 'live.WETH',
      tokenOutRef: 'live.USD', ...node, maxSlippageBps: 50, observationRefs: [],
    };
  };
  const trading = async (scope: AgentScope, asset: string) => {
    const row = (await agentBalances(h.pool, scope)).find((b) => b.kind === 'user' && b.bucket === 'trading' && b.assetRef === asset);
    return { balance: row?.balance ?? 0n, held: row?.held ?? 0n };
  };

  test('admission reserves token-in and the gas ceiling on the ledger, counts the window, and settles actual effects once', async () => {
    const a = await arrangeLive();
    const intent = await intentFor(a);
    const first = await h.post(intent, a.liveCapability());
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.ok(validate('intentResult', first.json).ok, JSON.stringify(first.json));
    assert.deepEqual([first.json['mode'], first.json['state']], ['live', 'reserved'], JSON.stringify(first.json['reason']));
    assert.deepEqual(await trading(a.scope, 'live.WETH'), { balance: 2n * WETH, held: WETH / 5n });
    assert.deepEqual(await trading(a.scope, 'live.MON'), { balance: 10n ** 16n, held: GAS_CEILING });
    const again = await h.post(intent, a.liveCapability());
    assert.deepEqual([again.status, again.json['intentId']], [202, first.json['intentId']]);
    const w = await h.pool.query<{ pending_actions: number; pending_notional_usd_micros: string }>(`select pending_actions, pending_notional_usd_micros from spend_windows where scope_key = $1`, [`agent:${a.agentId}`]);
    assert.deepEqual([w.rows[0]!.pending_actions, w.rows[0]!.pending_notional_usd_micros], [1, '500000000']);

    // The signing pipeline's transitions: signing-phase verdict, submitted, finalized receipt.
    const id = first.json['intentId'] as string;
    const allow = evaluateAction({ mode: 'paper', deploymentActive: true, connectorEnabled: true, assetsAllowed: true, requestedSlippageBps: 0, limits: [{ maxSlippageBps: 50, dailyActionCount: 9 }], resolvedInputAtomic: 1n, availableInputAtomic: 1n, actionsInWindow: 0, valuation: { observedAtMillis: Date.now(), maxAgeSeconds: 60 }, nowMillis: Date.now() });
    await intents.markSigning(id, allow, `0x${'1'.repeat(64)}`, new Date());
    const hash = `0x${'ab'.repeat(32)}`;
    await intents.markSubmitted(id, hash, new Date());
    const settled = await intents.settleFinalized(id, { txHash: hash, succeeded: true, inputAtomic: WETH / 5n, outputAtomic: 498_000_000n, gasAtomic: 3n * 10n ** 14n }, new Date());
    assert.equal(settled.state, 'settled');
    assert.deepEqual(await trading(a.scope, 'live.WETH'), { balance: 2n * WETH - WETH / 5n, held: 0n });
    assert.deepEqual(await trading(a.scope, 'live.MON'), { balance: 10n ** 16n - 3n * 10n ** 14n, held: 0n });
    assert.deepEqual(await trading(a.scope, 'live.USD'), { balance: 498_000_000n, held: 0n });
    const again2 = await intents.settleFinalized(id, { txHash: hash, succeeded: true, inputAtomic: WETH / 5n, outputAtomic: 498_000_000n, gasAtomic: 3n * 10n ** 14n }, new Date());
    assert.equal(again2.settledOutputAtomic, 498_000_000n, 'a repeated settlement posts nothing new');
    const status = await h.get(id, a.liveCapability());
    assert.ok(validate('intentResult', status.json).ok, JSON.stringify(status.json));
    assert.deepEqual([status.json['transactionHash'], (status.json['settlement'] as Record<string, string>)['gasAtomic']], [hash, String(3n * 10n ** 14n)]);
    const out = await h.pool.query<{ type: string }>(`select type from executor_outbox where intent_id = $1 order by id`, [id]);
    assert.ok(out.rows.some((r) => r.type === 'ledger.settled'));
  });

  test('concurrent live intents cannot overspend trading inventory', async () => {
    const a = await arrangeLive(WETH);
    const [x, y] = await Promise.all([intentFor(a, 'sell_fixed', [0]), intentFor(a, 'sell_fixed', [1])]);
    const answers = await Promise.all([h.post(x, a.liveCapability()), h.post(y, a.liveCapability())]);
    assert.deepEqual(answers.map((r) => r.json['state']).sort(), ['rejected', 'reserved'], JSON.stringify(answers.map((r) => r.json)));
    const rejected = answers.find((r) => r.json['state'] === 'rejected')!;
    assert.match(String((rejected.json['reason'] as Record<string, string>)['code']), /EXECUTOR_(AMOUNT_EXCEEDED|INSUFFICIENT_BUDGET)/);
    assert.equal((await trading(a.scope, 'live.WETH')).held, 6n * WETH / 10n);
  });

  test('a reconciliation freeze or missing gas reserve rejects admission with a stable reason and holds nothing', async () => {
    const poor = await arrangeLive(2n * WETH, GAS_CEILING - 1n);
    const r1 = await h.post(await intentFor(poor), poor.liveCapability());
    assert.deepEqual([r1.json['state'], (r1.json['reason'] as Record<string, string>)['code']], ['rejected', 'EXECUTOR_INSUFFICIENT_BUDGET']);
    assert.equal((await trading(poor.scope, 'live.WETH')).held, 0n);
    const frozen = await arrangeLive();
    const c = await h.pool.connect();
    try {
      await freeze(c, { mode: 'live', tenantId: frozen.tenantId, agentId: frozen.agentId, reasonCode: 'BALANCE_DEFICIT', detail: {}, sourceKey: `test:${frozen.agentId}`, now: new Date() });
    } finally {
      c.release();
    }
    const r2 = await h.post(await intentFor(frozen), frozen.liveCapability());
    assert.deepEqual([r2.json['state'], (r2.json['reason'] as Record<string, string>)['code']], ['rejected', 'EXECUTOR_RECONCILIATION_REQUIRED']);
  });

  test('pause before signing cancels and releases; a revert charges gas only; a paper capability cannot reach a live deployment', async () => {
    const a = await arrangeLive();
    const r = await h.post(await intentFor(a), a.liveCapability());
    h.authority.set(a.deploymentId, { desiredState: 'paused' });
    await h.service.reconcile();
    const cancelled = await h.get(r.json['intentId'] as string, a.liveCapability());
    assert.deepEqual([cancelled.json['state'], (cancelled.json['reason'] as Record<string, string>)['code']], ['cancelled', 'EXECUTOR_DEPLOYMENT_INACTIVE']);
    assert.deepEqual([(await trading(a.scope, 'live.WETH')).held, (await trading(a.scope, 'live.MON')).held], [0n, 0n]);

    const b = await arrangeLive();
    const rb = await h.post(await intentFor(b), b.liveCapability());
    const id = rb.json['intentId'] as string;
    const allow = { allow: true as const, policyVersion: 'action-policy/2' };
    await intents.markSigning(id, allow, `0x${'2'.repeat(64)}`, new Date());
    const hash = `0x${'cd'.repeat(32)}`;
    await intents.markSubmitted(id, hash, new Date());
    const failed = await intents.settleFinalized(id, { txHash: hash, succeeded: false, inputAtomic: 0n, outputAtomic: 0n, gasAtomic: 2n * 10n ** 14n }, new Date());
    assert.equal(failed.state, 'failed');
    assert.deepEqual(await trading(b.scope, 'live.WETH'), { balance: 2n * WETH, held: 0n });
    assert.deepEqual(await trading(b.scope, 'live.MON'), { balance: 10n ** 16n - 2n * 10n ** 14n, held: 0n });

    const paperCap = await h.post(await intentFor(b, 'sell_fixed', [0]), b.capability({ connectors: { 'live.uniswap': '1.0.0' } }));
    assert.equal(paperCap.status, 403);
    assert.equal(user(b.scope, 'trading', 'live.WETH').kind, 'user');
  });
});
