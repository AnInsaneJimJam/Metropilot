// G5 funds over the user API and the hosting meter (api-and-data.md section 4; funds-and-budgets.md sections 3, 5–7).
// Real PostgreSQL, real Fastify routes (inject), the local custody/chain stand-ins and a captured step-up channel.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { validate } from '../packages/contracts/src/index.ts';
import { compileStrategy, PRESETS, syntheticCatalog } from '../packages/strategy/src/index.ts';
import { agentBalances, depositPostings, postJournal, allocate, publishRateCard, uuidv7 } from '../packages/accounting/src/index.ts';
import { DepositScanner, LocalChain, LocalCustody, NATIVE, WithdrawalGateway } from '../packages/custody/src/index.ts';
import type { CustodyConfig } from '../packages/custody/src/index.ts';
import { createApp } from '../apps/api/src/app.ts';
import { FundsService } from '../apps/api/src/funds.ts';
import { ControlStore } from '../apps/api/src/store.ts';
import { RuntimeControlStore } from '../apps/api/src/runtime-control/store.ts';
import { LOCAL_IMAGE_DIGEST, PAPER_CONNECTOR_VERSIONS } from '../apps/runtime/src/local/environment.ts';
import { databaseSkip, SEED_TENANT, scratchDb } from './scratch-db.ts';
import type { ScratchDb } from './scratch-db.ts';

const skip = await databaseSkip();
const USDC = '0x00000000000000000000000000000000000000aa';
const config: CustodyConfig = {
  networkRef: 'local-chain', chainId: 31_337, gasAssetRef: 'local.MON', startHeight: 0n,
  assets: [
    { assetRef: 'local.USD', chainId: 31_337, token: USDC, decimals: 6, funding: true },
    { assetRef: 'local.MON', chainId: 31_337, token: 'native', decimals: 18, funding: true },
  ],
};

describe('funds API', { skip }, () => {
  let db: ScratchDb;
  let chain: LocalChain;
  let custody: LocalCustody;
  let app: ReturnType<typeof createApp>;
  const codes = new Map<string, string>();
  before(async () => {
    db = await scratchDb('funds_api_test');
    chain = new LocalChain(31_337, 2);
    custody = new LocalCustody(chain);
    const funds = new FundsService({ pool: db.pool, custody: { provider: custody, config }, stepUp: { deliver: async (_t, id, code) => void codes.set(id, code) } });
    app = createApp({ store: new ControlStore(db.pool), funds, origin: 'http://127.0.0.1:5173', authenticate: async (cookie) => (cookie === 'ok' ? SEED_TENANT : undefined) });
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
    assert.equal((await call('POST', `/v1/step-up/challenges/${id}/verify`, { code: '000000' === codes.get(id) ? '111111' : '000000' })).status, 403);
    assert.equal((await call('POST', `/v1/step-up/challenges/${id}/verify`, { code: codes.get(id) })).status, 200);
    return id;
  };

  async function agent(): Promise<string> {
    const id = uuidv7();
    await db.pool.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'funds api agent')`, [SEED_TENANT, id]);
    return id;
  }

  test('wallet, finalized deposit, conserved allocation, step-up withdrawal while no deployment runs', async () => {
    const agentId = await agent();
    const wallet = await call('POST', `/v1/agents/${agentId}/wallet`);
    assert.equal(wallet.status, 200);
    const address = wallet.json['address'] as string;
    chain.fund(USDC, address, 100_000_000n);
    chain.fund(NATIVE, address, 10n ** 17n);
    chain.mine();
    const scanner = new DepositScanner(db.pool, chain, config);
    await scanner.tick(new Date());
    let funds = await call('GET', `/v1/agents/${agentId}/balances`);
    assert.ok(validate('agentFunds', funds.json).ok, JSON.stringify(funds.json));
    assert.equal((funds.json['pendingDeposits'] as unknown[]).length, 2);
    assert.deepEqual(funds.json['buckets'], []);
    chain.mine(3);
    await scanner.tick(new Date());
    funds = await call('GET', `/v1/agents/${agentId}/balances`);
    assert.deepEqual((funds.json['buckets'] as { bucket: string; assetRef: string; balance: string }[]).map((b) => `${b.bucket}:${b.assetRef}:${b.balance}`).sort(),
      ['unallocated:local.MON:100000000000000000', 'unallocated:local.USD:100000000'].sort());

    // Allocation: increasing trading needs a step-up for the exact terms; stale versions conflict.
    const terms = { assetRef: 'local.USD', expectedBudgetVersion: 1, targets: [{ bucket: 'hosting', amount: '10000000' }, { bucket: 'api', amount: '20000000' }, { bucket: 'trading', amount: '70000000' }] };
    assert.equal((await call('POST', `/v1/agents/${agentId}/allocations`, terms, 'alloc-0001')).status, 403);
    const stepUpId = await approve({ purpose: 'allocation', agentId, ...terms });
    const allocated = await call('POST', `/v1/agents/${agentId}/allocations`, { ...terms, stepUpId }, 'alloc-0002');
    assert.equal(allocated.status, 200, JSON.stringify(allocated.json));
    assert.equal(allocated.json['budgetVersion'], 2);
    assert.deepEqual(await call('POST', `/v1/agents/${agentId}/allocations`, { ...terms, stepUpId }, 'alloc-0002'), allocated, 'replay returns the original');
    assert.equal((await call('POST', `/v1/agents/${agentId}/allocations`, { ...terms, targets: [{ bucket: 'hosting', amount: '5' }] }, 'alloc-0003')).json['code'], 'REVISION_CONFLICT');
    const monTerms = { assetRef: 'local.MON', expectedBudgetVersion: 2, targets: [{ bucket: 'trading', amount: '100000000000000000' }] };
    assert.equal((await call('POST', `/v1/agents/${agentId}/allocations`, { ...monTerms, stepUpId: await approve({ purpose: 'allocation', agentId, ...monTerms }) }, 'alloc-0004')).status, 200);

    // Destination and withdrawal: the approval binds amount and destination.
    const dest = { chainId: 31_337, address: '0x00000000000000000000000000000000000000d7', label: 'Owner wallet' };
    const destination = await call('POST', `/v1/agents/${agentId}/withdrawal-destinations`, { ...dest, stepUpId: await approve({ purpose: 'destination', agentId, ...dest }) }, 'dest-0001');
    assert.equal(destination.status, 201, JSON.stringify(destination.json));
    const wd = { assetRef: 'local.USD', amount: '5000000', destinationId: destination.json['id'] as string };
    const wrongApproval = await approve({ purpose: 'withdrawal', agentId, ...wd, amount: '4000000' });
    assert.equal((await call('POST', `/v1/agents/${agentId}/withdrawals`, { ...wd, stepUpId: wrongApproval }, 'wd-000001')).status, 403);
    const withdrawal = await call('POST', `/v1/agents/${agentId}/withdrawals`, { ...wd, stepUpId: await approve({ purpose: 'withdrawal', agentId, ...wd }) }, 'wd-000002');
    assert.equal(withdrawal.status, 202, JSON.stringify(withdrawal.json));
    assert.ok(validate('withdrawal', withdrawal.json).ok);
    const walletRow = await db.pool.query<{ provider_wallet_id: string }>('select provider_wallet_id from wallets where agent_id = $1', [agentId]);
    custody.wallets.get(walletRow.rows[0]!.provider_wallet_id)!.allowedTo.add(USDC);
    const gateway = new WithdrawalGateway(db.pool, custody, chain, config);
    await gateway.tick(new Date());
    chain.mine(3);
    await gateway.tick(new Date());
    const done = await call('GET', `/v1/withdrawals/${withdrawal.json['id'] as string}`);
    assert.equal(done.json['state'], 'finalized');
    assert.equal(chain.balanceOf(USDC, dest.address), 5_000_000n);
  });

  test('a strategy cannot create a withdrawal: the only intent action is a swap, and no runtime or executor route reaches withdrawals', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fixtures = join(import.meta.dirname, '..', 'packages', 'contracts', 'fixtures', 'actionIntent', 'valid');
    const intent = JSON.parse(readFileSync(join(fixtures, readdirSync(fixtures)[0]!), 'utf8')) as Record<string, unknown>;
    assert.equal(validate('actionIntent', intent).ok, true);
    for (const action of ['withdraw', 'transfer', 'treasury.sweep']) assert.equal(validate('actionIntent', { ...intent, action }).ok, false, action);
    assert.equal(validate('actionIntent', { ...intent, recipient: '0x00000000000000000000000000000000000000d7' }).ok, false);
    // The runtime and the language never name withdrawals; the executor's intent path (service, HTTP server) neither.
    // A future executor-hosted withdrawal gateway (#37) belongs in its own module, outside this list.
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = [
      ...['apps/runtime/src', 'packages/strategy/src'].flatMap((dir) => walk(join(import.meta.dirname, '..', dir))),
      ...['service.ts', 'server.ts'].map((f) => join(import.meta.dirname, '..', 'apps', 'executor', 'src', f)),
    ].filter((f) => f.endsWith('.ts'));
    for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /withdrawal/i, file);
  });

  test('a funding quote follows the published rate cards and is stored with its expiry', async () => {
    const agentId = await agent();
    const at = new Date('2026-01-01T00:00:00Z');
    await publishRateCard(db.pool, { version: 'hosting.small/test', kind: 'hosting', mode: 'live', profileRef: 'runtime.small', assetRef: 'local.USD', sliceSeconds: 60, atomicPerSlice: 694n, marginBps: 2000, effectiveFrom: at, source: 'placeholder (test)' });
    await publishRateCard(db.pool, { version: 'model.kimi/test', kind: 'model', mode: 'live', profileRef: 'live.kimi', assetRef: 'local.USD', inputAtomicPerMillion: 600_000n, outputAtomicPerMillion: 2_500_000n, marginBps: 2000, effectiveFrom: at, source: 'placeholder (test)' });
    const quote = await call('POST', `/v1/agents/${agentId}/funding-quotes`, {
      assetRef: 'local.USD', depositAtomic: '100000000', minTradingAtomic: '70000000', gasAtomic: '1000000', resourceProfileRef: 'runtime.small',
      modelProfileRef: 'live.kimi', aiCallsPerDay: 24, maxInputTokens: 4000, maxOutputTokens: 1000, marginBps: 2000,
    });
    assert.equal(quote.status, 200, JSON.stringify(quote.json));
    assert.ok(validate('fundingQuote', quote.json).ok, JSON.stringify(quote.json));
    assert.equal(quote.json['feasible'], true);
    const allocations = quote.json['allocations'] as { bucket: string; amount: string }[];
    assert.equal(allocations.reduce((s, a) => s + BigInt(a.amount), 0n), 100_000_000n, 'the proposal conserves the deposit');
    assert.deepEqual((quote.json['dailyCost'] as { amount: string }[]).map((d) => d.amount), [String(694 * 1440), String(24 * (Math.ceil((4000 * 600_000 + 1000 * 2_500_000) / 1_000_000)))]);
    assert.equal((await db.pool.query('select 1 from funding_quotes where id = $1', [quote.json['id']])).rowCount, 1);
    assert.equal((await call('POST', `/v1/agents/${agentId}/funding-quotes`, { assetRef: 'local.USD', depositAtomic: '1', minTradingAtomic: '0', gasAtomic: '0', resourceProfileRef: 'unknown.profile', aiCallsPerDay: 0, maxInputTokens: 0, maxOutputTokens: 0, marginBps: 0 })).json['code'], 'CAPABILITY_DISABLED');
  });

  test('hosting budget exhaustion pauses the deployment with a visible reason and never touches trading funds', async () => {
    const store = new RuntimeControlStore({ pool: db.pool });
    const tenantId = SEED_TENANT;
    const agentId = await agent();
    const revisionId = uuidv7();
    const program = await compileStrategy(JSON.stringify(PRESETS[0]!.strategy), syntheticCatalog);
    await db.pool.query(`insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation) values ($1, $2, $3, 'strategy/1', $4, $5, '{}')`, [tenantId, revisionId, agentId, program.hash, program.strategy]);
    const estimateId = uuidv7();
    const simulationAccountId = uuidv7();
    await db.pool.query(`insert into policies (tenant_id, agent_id, version, limits) values ($1, $2, 1, '{"maxSlippageBps": 50, "dailyActionCount": 24}')`, [tenantId, agentId]);
    await db.pool.query(`insert into estimates (tenant_id, id, agent_id, strategy_revision_id, assumptions, created_at, expires_at) values ($1, $2, $3, $4, '{}', now(), now() + interval '15 minutes')`, [tenantId, estimateId, agentId, revisionId]);
    await db.pool.query('insert into simulation_accounts (tenant_id, id, agent_id, session) values ($1, $2, $3, 1)', [tenantId, simulationAccountId, agentId]);
    const { deploymentId } = await store.deploy({
      tenantId, agentId, strategyRevisionId: revisionId, mode: 'paper', catalog: syntheticCatalog, connectorVersions: PAPER_CONNECTOR_VERSIONS, runtimeImageDigest: LOCAL_IMAGE_DIGEST,
      networkRef: 'paper-monad', policyVersion: 1, budgetVersion: 1, resourceProfileRef: 'paper-billed-v1', modelProfiles: {}, estimateId, simulationAccountId,
    });
    // A billed paper profile: hosting is charged from the paper hosting bucket (3 slices' worth).
    await publishRateCard(db.pool, { version: 'hosting.paper-billed/test', kind: 'hosting', mode: 'paper', profileRef: 'paper-billed-v1', assetRef: 'paper.USD', sliceSeconds: 60, atomicPerSlice: 10n, marginBps: 0, effectiveFrom: new Date('2026-01-01T00:00:00Z'), source: 'placeholder (test)' });
    const scope = { mode: 'paper' as const, tenantId, agentId };
    await db.tx(async (c) => {
      await postJournal(c, { operationKey: `paper-fund:${agentId}`, mode: 'paper', tenantId, agentId, kind: 'deposit', postings: depositPostings(scope, 'paper.USD', 1030n), occurredAt: new Date() });
      await allocate(c, { scope, assetRef: 'paper.USD', expectedBudgetVersion: 1, targets: { hosting: 30n, trading: 1000n }, actor: 'test', now: new Date() });
    });
    const first = await store.meterHosting();
    assert.ok(first.charged >= 2 && !first.paused.includes(deploymentId), JSON.stringify(first));
    assert.equal((await store.meterHosting()).paused.length, 0, 'same slices are not charged twice');
    // Advance two slices: the third slice is paid, the fourth cannot be.
    const later = new RuntimeControlStore({ pool: db.pool, now: () => new Date(Date.now() + 120_000).toISOString() });
    const second = await later.meterHosting();
    assert.ok(second.paused.includes(deploymentId), JSON.stringify(second));
    const d = await db.pool.query<{ desired_state: string; pause_reason: string }>('select desired_state, pause_reason from deployments where id = $1', [deploymentId]);
    assert.equal(d.rows[0]!.desired_state, 'paused');
    assert.match(d.rows[0]!.pause_reason, /hosting budget is exhausted/);
    const balances = await agentBalances(db.pool, scope);
    assert.equal(balances.find((b) => b.bucket === 'trading')!.balance, 1000n);
    assert.equal(balances.find((b) => b.bucket === 'hosting')!.balance, 0n);
    const audit = await db.pool.query(`select 1 from audit_events where deployment_id = $1 and type = 'deployment.stateChanged' and payload ->> 'to' = 'paused' and payload ->> 'reasonCode' = 'HOSTING_BUDGET_EXHAUSTED'`, [deploymentId]);
    assert.equal(audit.rowCount, 1);
  });
});
