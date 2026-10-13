// Live launch over the user API (D60; executor.md section 9; funds-and-budgets.md sections 3–4). Real PostgreSQL and
// Fastify routes; the custody provider and chain are the labelled local stand-ins on chain 143's identity, so nothing
// touches a network. A saved paper strategy is promoted to live refs, caps are set with a step-up, the agent's wallet
// is funded and allocated, and the launch creates a live deployment the executor's catalog check accepts.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { contentHash, intentKey, validate } from '../packages/contracts/src/index.ts';
import type { Strategy } from '../packages/contracts/src/index.ts';
import { uuidv7 } from '../packages/accounting/src/index.ts';
import { DepositScanner, LocalChain, LocalCustody, NATIVE } from '../packages/custody/src/index.ts';
import type { CustodyConfig } from '../packages/custody/src/index.ts';
import { createApp } from '../apps/api/src/app.ts';
import { FundsService } from '../apps/api/src/funds.ts';
import { ControlStore } from '../apps/api/src/store.ts';
import { RuntimeControlStore } from '../apps/api/src/runtime-control/store.ts';
import { CatalogResolver } from '../apps/api/src/catalog.ts';
import { LifecycleService } from '../apps/api/src/lifecycle.ts';
import { seedLiveCatalog } from '../apps/api/src/db/live-catalog.ts';
import { ExecutorStore } from '../apps/executor/src/store.ts';
import { LOCAL_IMAGE_DIGEST } from '../apps/runtime/src/local/environment.ts';
import { databaseSkip, SEED_TENANT, scratchDb } from './scratch-db.ts';
import type { ScratchDb } from './scratch-db.ts';

const skip = await databaseSkip();
const CHAIN = 143;
const config: CustodyConfig = {
  networkRef: 'monad-mainnet', chainId: CHAIN, gasAssetRef: 'mainnet.MON', startHeight: 0n,
  assets: [{ assetRef: 'mainnet.MON', chainId: CHAIN, token: 'native', decimals: 18, funding: true }],
};
const E18 = 10n ** 18n;
const strategy = (body: Strategy['triggers'][number]['body'], trigger: Partial<Strategy['triggers'][number]> = {}): Strategy => ({
  schemaVersion: 'strategy/1', id: 'live_dca', name: 'Hourly MON to USDC (test)',
  triggers: [{ id: 'hourly', type: 'schedule', intervalSeconds: 3600, anchorAt: '2026-10-01T00:00:00.000Z', body, ...trigger } as Strategy['triggers'][number]],
  limits: { maxStepsPerRun: 10, maxAiCallsPerRun: 0, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 },
});
const sell = { id: 'sell', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.MON', tokenOutRef: 'paper.USDC', amount: { kind: 'fixed', atomic: E18.toString() }, maxSlippageBps: 50 } as const;

describe('live launch', { skip }, () => {
  let db: ScratchDb;
  let chain: LocalChain;
  let app: ReturnType<typeof createApp>;
  const codes = new Map<string, string>();
  before(async () => {
    db = await scratchDb('live_launch_test');
    const c = await db.pool.connect();
    try {
      await seedLiveCatalog(c);
    } finally {
      c.release();
    }
    chain = new LocalChain(CHAIN, 2);
    const funds = new FundsService({ pool: db.pool, custody: { provider: new LocalCustody(chain), config }, stepUp: { deliver: async (_t, id, code) => void codes.set(id, code) } });
    const lifecycle = new LifecycleService({
      pool: db.pool, runtime: new RuntimeControlStore({ pool: db.pool }), runtimeImageDigest: LOCAL_IMAGE_DIGEST, catalog: new CatalogResolver(),
      live: { networkRef: 'monad-mainnet', chainId: CHAIN, gasAssetRef: 'mainnet.MON', minTradingGasAtomic: 15n * 10n ** 16n },
    });
    app = createApp({ store: new ControlStore(db.pool), funds, lifecycle, origin: 'http://127.0.0.1:5173', authenticate: async (cookie) => (cookie === 'ok' ? SEED_TENANT : undefined) });
  });
  after(async () => {
    await app?.close();
    await db?.drop();
  });

  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, key?: string) => {
    const res = await app.inject({ method, url, headers: { cookie: 'ok', ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, json: res.json() as Record<string, unknown> };
  };
  const approve = async (terms: Record<string, unknown>): Promise<string> => {
    const start = await call('POST', '/v1/step-up/challenges', terms);
    assert.equal(start.status, 201, JSON.stringify(start.json));
    const id = start.json['challengeId'] as string;
    assert.equal((await call('POST', `/v1/step-up/challenges/${id}/verify`, { code: codes.get(id) })).status, 200);
    return id;
  };
  async function agent(experience: 'rookie' | 'advanced', ast: Strategy): Promise<{ agentId: string; revisionId: string }> {
    const agentId = uuidv7();
    const revisionId = uuidv7();
    await db.pool.query(`insert into agents (tenant_id, id, name, experience) values ($1, $2, 'live launch agent', $3)`, [SEED_TENANT, agentId, experience]);
    await db.pool.query(`insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation) values ($1, $2, $3, 'strategy/1', $4, $5, '{}')`,
      [SEED_TENANT, revisionId, agentId, await contentHash(ast), ast]);
    await db.pool.query('update agents set revision_id = $3 where tenant_id = $1 and id = $2', [SEED_TENANT, agentId, revisionId]);
    return { agentId, revisionId };
  }
  const limits = { maxSlippageBps: 50, dailyActionCount: 5, dailyNotionalUsdMicros: '5000000' };
  let approval = '';
  const setCaps = async (agentId: string) => {
    approval = await approve({ purpose: 'livePolicy', agentId, limits });
    const set = await call('POST', `/v1/agents/${agentId}/live-policy`, { limits, stepUpId: approval });
    assert.equal(set.status, 201, JSON.stringify(set.json));
    return set.json['policyVersion'] as number;
  };
  const request = (agentId: string, revisionId: string, estimate: Record<string, unknown>, stepUpApprovalId = approval) => ({
    schemaVersion: 'deployment/1', agentId, strategyRevisionId: revisionId, mode: 'live', networkRef: 'monad-mainnet', stepUpApprovalId,
    connectorSelections: [{ ref: 'mainnet.uniswap-v3', version: '1.1.0', capabilities: ['swap.exactInput'] }], modelProfiles: [], resourceProfileRef: 'live-small-v1',
    budgetVersion: estimate['budgetVersion'], policyVersion: estimate['policyVersion'], estimateId: estimate['id'],
  });

  test('a saved paper strategy launches live: caps by step-up, funded wallet, promoted revision, executor catalog accepts it', async () => {
    const { agentId, revisionId } = await agent('advanced', strategy([sell]));
    // Caps need fresh consent for exactly these limits.
    assert.equal((await call('POST', `/v1/agents/${agentId}/live-policy`, { limits, stepUpId: await approve({ purpose: 'livePolicy', agentId, limits: { ...limits, dailyActionCount: 6 } }) })).status, 403);
    const policyVersion = await setCaps(agentId);
    const estimate = await call('POST', `/v1/agents/${agentId}/estimates`, { mode: 'live' });
    assert.equal(estimate.status, 200, JSON.stringify(estimate.json));
    assert.ok(validate('liveEstimate', estimate.json).ok, JSON.stringify(estimate.json));
    assert.equal(estimate.json['policyVersion'], policyVersion);
    // Not funded yet.
    const unfunded = await call('POST', `/v1/agents/${agentId}/deployments`, request(agentId, revisionId, estimate.json), 'live-0001');
    assert.deepEqual([unfunded.status, unfunded.json['code']], [422, 'FUNDING_PENDING'], JSON.stringify(unfunded.json));

    const wallet = await call('POST', `/v1/agents/${agentId}/wallet`);
    chain.fund(NATIVE, wallet.json['address'] as string, E18);
    chain.mine(3);
    await new DepositScanner(db.pool, chain, config).tick(new Date());
    const funds = await call('GET', `/v1/agents/${agentId}/balances`);
    const terms = { assetRef: 'mainnet.MON', expectedBudgetVersion: funds.json['budgetVersion'], targets: [{ bucket: 'trading', amount: (E18 / 2n).toString() }] };
    assert.equal((await call('POST', `/v1/agents/${agentId}/allocations`, { ...terms, stepUpId: await approve({ purpose: 'allocation', agentId, ...terms }) }, 'alloc-live')).status, 200);
    const fresh = await call('POST', `/v1/agents/${agentId}/estimates`, { mode: 'live' });
    // Only the approval that set these caps counts as consent.
    const other = await call('POST', `/v1/agents/${agentId}/deployments`, request(agentId, revisionId, fresh.json, uuidv7()), 'live-0003');
    assert.deepEqual([other.status, other.json['code']], [403, 'FORBIDDEN']);
    const launched = await call('POST', `/v1/agents/${agentId}/deployments`, request(agentId, revisionId, fresh.json), 'live-0002');
    assert.equal(launched.status, 202, JSON.stringify(launched.json));

    const d = (await db.pool.query<{ id: string; mode: string; strategy_revision_id: string; connector_versions: Record<string, string>; simulation_account_id: string | null; network_ref: string }>(
      'select id, mode, strategy_revision_id, connector_versions, simulation_account_id, network_ref from deployments where agent_id = $1', [agentId])).rows[0]!;
    assert.deepEqual([d.mode, d.network_ref, d.simulation_account_id, d.connector_versions], ['live', 'monad-mainnet', null, { 'mainnet.uniswap-v3': '1.1.0' }]);
    const derived = (await db.pool.query<{ ast: Strategy; validation: Record<string, string> }>('select ast, validation from strategy_revisions where id = $1', [d.strategy_revision_id])).rows[0]!;
    assert.equal(derived.validation['derivedFrom'], revisionId);
    const node = derived.ast.triggers[0]!.body[0] as unknown as typeof sell;
    assert.deepEqual([node.connectorRef, node.tokenInRef, node.tokenOutRef], ['mainnet.uniswap-v3', 'mainnet.MON', 'mainnet.USDC']);
    assert.deepEqual(await new ExecutorStore(db.pool).catalogAllows('mainnet.uniswap-v3', '1.1.0', 'swap.exactInput', 'monad-mainnet', ['mainnet.MON', 'mainnet.USDC'], 'live'), { connector: true, assets: true });
    const view = await call('GET', `/v1/agents/${agentId}/deployment`);
    assert.deepEqual([view.json['mode'], view.json['desiredState']], ['live', 'active']);
    // Executor intents carry the live refs and a key from the deployment generation.
    assert.match(await intentKey({ deploymentId: d.id, generation: '1', runId: `0x${'1'.repeat(64)}`, nodeId: 'sell', iterationPath: [] }), /^0x[0-9a-f]{64}$/);
    // Live capability and versions are advertised.
    const catalog = await call('GET', '/v1/catalog');
    assert.equal((catalog.json['capabilities'] as Record<string, unknown>)['live'], true);
    assert.equal((catalog.json['liveVersions'] as { connectors: Record<string, string> }).connectors['mainnet.uniswap-v3'], '1.1.0');
  });

  test('live refusals: rookie, market reads or AI steps, price triggers, and no live caps', async () => {
    const rookie = await agent('rookie', strategy([sell]));
    await setCaps(rookie.agentId);
    assert.equal((await call('POST', `/v1/agents/${rookie.agentId}/estimates`, { mode: 'live' })).json['code'], 'POLICY_DENIED');

    const noCaps = await agent('advanced', strategy([sell]));
    const uncapped = await call('POST', `/v1/agents/${noCaps.agentId}/estimates`, { mode: 'live' });
    assert.deepEqual([uncapped.status, uncapped.json['code']], [422, 'UNKNOWN_REFERENCE']);

    const withRead = await agent('advanced', strategy([{ id: 'price', type: 'read', connectorRef: 'paper.uniswap', operation: 'price.read', arguments: {}, bind: 'p' } as never, sell]));
    await setCaps(withRead.agentId);
    const read = await call('POST', `/v1/agents/${withRead.agentId}/estimates`, { mode: 'live' });
    assert.deepEqual([read.status, read.json['code']], [422, 'UNSUPPORTED_CAPABILITY']);
    assert.match(String(read.json['message']), /market reads or AI/);

    const priced = await agent('advanced', strategy([sell], { type: 'price.crossesBelow', feedRef: 'paper.wmon-usdc' } as never));
    await setCaps(priced.agentId);
    assert.match(String((await call('POST', `/v1/agents/${priced.agentId}/estimates`, { mode: 'live' })).json['message']), /schedule triggers/);
  });
});
