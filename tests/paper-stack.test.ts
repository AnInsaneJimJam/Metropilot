import { marketCatalog, MARKETS, AAVE_RESERVES } from '../packages/connectors/src/registry.ts';
import { decimal } from '../packages/strategy/src/expression.ts';
import type { Strategy } from '../packages/contracts/src/index.ts';
import { checkedObservation } from '../packages/connectors/src/index.ts';
import { readFileSync } from 'node:fs';
import { MARKET_PRESETS } from '../packages/strategy/src/index.ts';
// The whole local paper stack on real PostgreSQL (TEST-2, INT-2): user API launch → runtime-facing control API
// → runtime HTTP clients → real paper executor (Postgres authority, recorded prices) → executor outbox → resumed
// runs, history and the live event stream. Synthetic paper data; the broker serves recorded reads and explicitly synthetic AI over HTTP.
// Skips without a reachable DATABASE_URL unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import pg from 'pg';
import { signCapability, verifyCapability } from '../packages/contracts/src/capability.ts';
import { contentHash, intentKey, validate } from '../packages/contracts/src/index.ts';
import { PRESETS, syntheticCatalog, workspaceFromStrategy } from '../packages/strategy/src/index.ts';
import { createApp } from '../apps/api/src/app.ts';
import { pruneAudit } from '../apps/api/src/db/cli.ts';
import { dailySeconds, sessionSeconds } from '../apps/api/src/quota.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';
import { LifecycleService } from '../apps/api/src/lifecycle.ts';
import { createInternalApp } from '../apps/api/src/runtime-control/app.ts';
import { RuntimeControlStore } from '../apps/api/src/runtime-control/store.ts';
import { ControlStore } from '../apps/api/src/store.ts';
import { createExecutor, PostgresAuthority, PostgresMarketData } from '../apps/executor/src/index.ts';
import { HttpControlApi } from '../apps/runtime/src/dispatch/control-api.ts';
import { HttpExecutor } from '../apps/runtime/src/dispatch/executor.ts';
import { HttpBroker } from '../apps/runtime/src/dispatch/broker.ts';
import { PaperBrokerService } from '../apps/api/src/broker-service.ts';
import { systemClock } from '../apps/runtime/src/ports.ts';
import type { CrashPoint } from '../apps/runtime/src/host.ts';
import type { HostCommand } from '../packages/strategy/src/index.ts';
import { Supervisor } from '../apps/runtime/src/supervisor.ts';

const required = process.env['REQUIRE_DB'] === '1';
let admin: pg.Client | undefined;
let skip: string | false = false;
if (!process.env['DATABASE_URL']) skip = 'DATABASE_URL is not set';
else {
  admin = new pg.Client({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    if (required) throw error;
    skip = `database unreachable (${(error as Error).message})`;
    admin = undefined;
  }
}
if (skip && required) throw new Error(`REQUIRE_DB=1 but ${skip}`);

const IMAGE = '0x' + '5a'.repeat(32);
const databases: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
let template: Promise<string> | undefined;
const urlFor = (name: string): string => { const url = new URL(process.env['DATABASE_URL']!); url.pathname = `/${name}`; return url.toString(); };
async function freshPool(): Promise<pg.Pool> {
  template ??= (async () => {
    const name = `stack_tpl_${randomBytes(5).toString('hex')}`;
    await admin!.query(`create database ${name}`);
    databases.push(name);
    const client = new pg.Client({ connectionString: urlFor(name) });
    await client.connect();
    await migrate(client);
    await seedPaper(client);
    await client.end();
    return name;
  })();
  const name = `stack_${randomBytes(6).toString('hex')}`;
  await admin!.query(`create database ${name} template ${await template}`);
  databases.push(name);
  const pool = new pg.Pool({ connectionString: urlFor(name), max: 12 });
  // pool.end() resolves before idle sockets close; the forced drop below may kill them (see app.test.ts).
  pool.on('connect', (client) => client.on('error', () => {}));
  pool.on('error', () => {});
  closers.push(() => pool.end());
  return pool;
}
after(async () => {
  for (const close of closers.reverse()) await close().catch(() => undefined);
  for (const name of databases.reverse()) await admin?.query(`drop database if exists ${name} with (force)`);
  await admin?.end();
});

const listen = async (server: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown; close: (cb?: () => void) => unknown }): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const budget = { tradingUsdMicros: '1000000000', hostingUsdMicros: '10000000', dataAndAiUsdMicros: '5000000', monReserveAtomic: '1000000000000000000' };

async function stack(options: { dispatchInline?: boolean; mainnet?: boolean } = {}) {
  const pool = await freshPool();
  const catalog: import("../packages/strategy/src/index.ts").Catalog = options.mainnet ? marketCatalog : syntheticCatalog;
  const presets = options.mainnet ? MARKET_PRESETS : PRESETS;
  const secret = randomBytes(32);
  const brokerSecret = randomBytes(32);
  const runtimeStore = new RuntimeControlStore({ pool, executorCapabilitySecret: secret, brokerCapabilitySecret: brokerSecret });
  const service = new PaperBrokerService({ pool, secret: brokerSecret });
  const controlStore = new ControlStore(pool);
  const tenant = await controlStore.tenant(`stack-${randomBytes(4).toString('hex')}`);
  // The lifecycle clock can be skewed forward to expire estimates (estimate rows are immutable).
  const skew = { millis: 0 };
  const lifecycle = new LifecycleService({ pool, runtime: runtimeStore, runtimeImageDigest: IMAGE, ...(options.mainnet ? { paperFundingAsset: 'paper.USDC' } : {}), now: () => new Date(Date.now() + skew.millis) });
  const user = createApp({ store: controlStore, lifecycle, catalog: () => lifecycle.paperCatalog(), origin: 'http://127.0.0.1:5173', authenticate: async (cookie) => (cookie === 'me' ? tenant : undefined), streamPollMillis: 20 });
  await user.ready();
  const userOrigin = await (async () => { await user.listen({ host: '127.0.0.1', port: 0 }); closers.push(() => user.close()); return `http://127.0.0.1:${(user.server.address() as AddressInfo).port}`; })();
  const internal = createInternalApp({ broker: service, store: runtimeStore, authenticateWorkload: (h) => (typeof h['x-runtime-workload'] === 'string' ? h['x-runtime-workload'] : undefined), pollIntervalMillis: 20 });
  await internal.listen({ host: '127.0.0.1', port: 0 });
  closers.push(() => internal.close());
  const internalOrigin = `http://127.0.0.1:${(internal.server.address() as AddressInfo).port}`;
  const feeds = Object.entries(catalog.feeds).filter(([,feed])=>catalog.connectors[feed.connectorRef]?.actions.includes('swap.exactInput')).map(([feedRef,feed]) => ({feedRef, connectorRef:feed.connectorRef, baseAssetRef:feed.baseAssetRef, quoteAssetRef:`paper.${feed.quoteUnit}`,baseDecimals:catalog.assets[feed.baseAssetRef]!.decimals,quoteDecimals:catalog.assets[`paper.${feed.quoteUnit}`]!.decimals}));
  const executor = createExecutor({
    pool, authority: new PostgresAuthority(pool), market: new PostgresMarketData(pool, feeds), capabilitySecret: secret,
    platformLimits: { maxSlippageBps: 100, dailyActionCount: 1000 }, maxQuoteAgeSeconds: 120, ...(options.dispatchInline === undefined ? {} : { dispatchInline: options.dispatchInline }),
  });
  const executorOrigin = await listen(executor.server);
  const control = new HttpControlApi({ origin: internalOrigin, workload: { 'x-runtime-workload': 'runtime-stack-1' } });
  const broker = new HttpBroker({ origin: internalOrigin, capability: () => control.brokerCapability(), forgetCapability: () => control.forgetBrokerCapability() });
  const httpExecutor = new HttpExecutor({ origin: executorOrigin, capability: () => control.executorCapability(), forgetCapability: () => control.forgetExecutorCapability() });
  const config = { runtimeId: 'runtime-stack-1', mode: 'paper' as const, imageDigest: IMAGE, heartbeatMillis: 10_000, pollWaitSeconds: 0 };
  const runtime = (crashAt?: (point: CrashPoint, command: HostCommand) => void) => new Supervisor({ config, control, broker, executor: httpExecutor, clock: systemClock, ...(crashAt ? { crashAt } : {}) });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${userOrigin}/v1${path}`, { method, headers: { cookie: 'me', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };
  /** Save the preset as a strategy, estimate it and return the deployment/1 request a launch sends. */
  const draft = async (presetId = 'ai_gated_purchase', experience: 'rookie' | 'advanced' = 'rookie', strategyOverride?: Strategy) => {
    const strategy = strategyOverride ?? presets.find((p) => p.id === presetId)!.strategy;
    const saved = await call('POST', '/agents', { schemaVersion: 'control-workspace/1', name: presetId, experience, workspace: workspaceFromStrategy(strategy, catalog), budget }, { 'idempotency-key': `save-${randomBytes(6).toString('hex')}` });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    const agentId = saved.json.id as string;
    const estimate = await call('POST', `/agents/${agentId}/estimates`, {});
    assert.equal(estimate.status, 200, JSON.stringify(estimate.json));
    assert.ok(validate('paperEstimate', estimate.json).ok, JSON.stringify(estimate.json));
    const connector = presetId.startsWith('aave_') ? 'paper.aave' : presetId.startsWith('curve_') ? 'paper.curve' : 'paper.uniswap';
    const request = {
      schemaVersion: 'deployment/1', agentId, strategyRevisionId: saved.json.revisionId, mode: 'paper', networkRef: 'paper-monad',
      // Mainnet presets take the newest enabled version, as the web does; synthetic ones pin their 1.0.1 definition.
      connectorSelections: [{ ref: connector, version: options.mainnet ? (await call('GET', '/catalog')).json.paperVersions.connectors[connector] : '1.0.1', capabilities: options.mainnet ? [...catalog.connectors[connector]!.actions] : ['price.read', 'swap.exactInput'] }],
      modelProfiles: presetId === 'ai_gated_purchase' ? [{ ref: 'paper.kimi', version: '1.1.0' }] : [],
      resourceProfileRef: 'paper-small-v1', budgetVersion: estimate.json.budgetVersion, policyVersion: estimate.json.policyVersion, estimateId: estimate.json.id,
    };
    return { agentId, request };
  };
  const launch = async (agentId: string, request: unknown, key = `launch-${randomBytes(6).toString('hex')}`) => call('POST', `/agents/${agentId}/deployments`, request, { 'idempotency-key': key });
  const observe = async (decimal = '2500') => {
    const now = new Date().toISOString();
    await runtimeStore.ingestPrice({ sourceEventKey: `obs-${randomBytes(6).toString('hex')}`, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal }, observedAt: now, receivedAt: now });
  };
  return { pool, secret, tenant, runtimeStore, lifecycle, executor, control, broker, runtime, call, draft, launch, observe, userOrigin, skew };
}

describe('paper stack end to end', { skip }, () => {
  for (const market of MARKETS) test(`${market.protocol}: native price.read and paper purchase with crash/replay`, async () => {
    const s = await stack({mainnet:true});
    const fixture = JSON.parse(readFileSync(new URL(`../packages/contracts/fixtures/priceObservation/valid/${market.protocol}.json`,import.meta.url),'utf8'));
    // Replay a recorded price using an explicit test clock; no CI network dependency.
    const now = new Date().toISOString();
    const observation = checkedObservation({...fixture, observedAt:now, receivedAt:now});
    await s.pool.query('insert into finalized_market_observations values ($1,$2,$3)',[market.feedRef,observation.sourceEventKey,observation]);
    await s.runtimeStore.ingestPrice(observation);
    const {agentId,request}=await s.draft(`${market.connectorRef.split('.')[1]}_scheduled_purchase`);
    const obsolete=structuredClone(request);obsolete.connectorSelections[0]!.version='1.0.0';
    if (obsolete.connectorSelections[0]!.version!==request.connectorSelections[0]!.version) assert.equal((await s.launch(agentId,obsolete)).status,422);
    assert.equal((await s.launch(agentId,request)).status,202);
    await s.runtimeStore.tickSchedules();
    let crashed=false;
    const runner=s.runtime((point,command)=>{if(point==='after-dispatch'&&command.kind==='read'&&!crashed){crashed=true;throw new Error('test crash after native read');}});
    await assert.rejects(runner.cycle(), /test crash after native read/);
    assert.equal(crashed,true);
    const readRun=(await s.pool.query("select run_id from broker_results where kind='read' and response->>'disposition'='completed'")).rows[0].run_id;
    await s.runtimeStore.reassign(readRun);
    const resumed=await s.runtime().cycle();
    assert.equal(resumed.outcome,'completed',JSON.stringify(resumed));
    await s.runtimeStore.consumeExecutorOutbox();
    const records=await s.pool.query("select response as document from broker_results where kind='read' and response->>'disposition'='completed'");
    assert.equal(records.rowCount,1);
    assert.equal(records.rows[0].document.value.price.quoteUnit,'USDC');
    assert.equal((await s.pool.query('select * from paper_fills')).rowCount,1);
    assert.equal((await s.pool.query('select * from market_observations where feed_ref=$1',[market.feedRef])).rowCount,1);
    assert.equal(await new PostgresMarketData(s.pool,[{feedRef:market.feedRef,connectorRef:market.connectorRef,baseAssetRef:observation.price.baseAssetRef,quoteAssetRef:'paper.USDC',baseDecimals:market.base==='WMON'?18:6,quoteDecimals:6}]).quote('paper.USDC',observation.price.baseAssetRef,'paper.wrong'),undefined);
  });

  for (const market of MARKETS) test(`${market.protocol}: recorded mainnet crossing produces one paper threshold sale with stage timings`, async () => {
    const s = await stack({mainnet:true});
    const fixtures = ['', '-later'].map(suffix => JSON.parse(readFileSync(new URL(`../packages/contracts/fixtures/priceObservation/valid/${market.protocol}${suffix}.json`,import.meta.url),'utf8')));
    assert.ok(BigInt(fixtures[0].block.number) < BigInt(fixtures[1].block.number));
    const before = decimal(fixtures[0].price.decimal), after = decimal(fixtures[1].price.decimal);
    assert.ok(before > after, 'Recorded mainnet prices crossed down; this replay never invents prices.');
    const midpoint = (before + after) / 2n;
    const threshold = `${midpoint/10n**18n}.${(midpoint%10n**18n).toString().padStart(18,'0')}`.replace(/0+$/,'').replace(/\.$/,'');
    const presetId = `${market.connectorRef.split('.')[1]}_threshold_sale`;
    const strategy = structuredClone(MARKET_PRESETS.find(p=>p.id===presetId)!.strategy);
    const trigger = strategy.triggers[0]!;
    assert.ok(trigger.type==='price.crossesAbove');
    strategy.triggers[0]={...trigger,type:'price.crossesBelow',threshold:{...trigger.threshold,decimal:threshold}}; // Explicit downside-sale configuration.
    const {agentId,request}=await s.draft(presetId,'rookie',strategy);
    assert.equal((await s.launch(agentId,request)).status,202);
    // Virtual inventory fixture, never a real deposit. A standalone sale correctly requires holdings.
    await s.pool.query('update simulation_balances set available=$1 where asset_ref=$2',[market.base==='WMON'?'1000000000000000000':'1000000',`paper.${market.base}`]);
    const received = new Date().toISOString();
    for (let index=0; index<fixtures.length; index++) {
      const observation=checkedObservation({...fixtures[index],observedAt:new Date(Date.now()-1000+index).toISOString(),receivedAt:received});
      await s.pool.query('insert into finalized_market_observations values ($1,$2,$3)',[market.feedRef,observation.sourceEventKey,observation]);
      const results=await s.runtimeStore.ingestPrice(observation);
      assert.equal(results.filter(r=>r.runId).length,index);
      assert.equal((await s.runtimeStore.ingestPrice(observation)).filter(r=>r.runId).length,0);
    }
    const report=await s.runtime().cycle();assert.equal(report.outcome,'completed',JSON.stringify(report));
    assert.equal(typeof report.timings?.observedToAccepted,'number');
    assert.equal(typeof report.timings?.verifiedToFirstDispatch,'number');
    assert.equal((await s.pool.query('select * from paper_fills')).rowCount,1);
    assert.equal((await s.pool.query('select * from runs')).rowCount,1);
  });

  for (const market of AAVE_RESERVES) test(`Aave ${market.base}: native USD price and reserve APR reads, no lending effects`, async () => {
    const s=await stack({mainnet:true});
    const fixture=JSON.parse(readFileSync(new URL(`../packages/contracts/fixtures/priceObservation/valid/aave-${market.base.toLowerCase()}.json`,import.meta.url),'utf8'));
    const now=new Date().toISOString(),observation=checkedObservation({...fixture,observedAt:now,receivedAt:now});
    await s.pool.query('insert into finalized_market_observations values ($1,$2,$3)',[market.feedRef,observation.sourceEventKey,observation]);
    await s.runtimeStore.ingestPrice(observation);
    const {agentId,request}=await s.draft(`aave_${market.base.toLowerCase()}_observe`);
    assert.equal((await s.launch(agentId,request)).status,202);
    await s.runtimeStore.tickSchedules();
    const report=await s.runtime().cycle();assert.equal(report.outcome,'completed',JSON.stringify(report));
    const reads=await s.pool.query("select response as document from broker_results where kind='read' and response->>'disposition'='completed'");assert.equal(reads.rowCount,2);
    assert.ok(reads.rows.some(r=>r.document.value.price?.quoteUnit==='USD'));
    assert.ok(reads.rows.some(r=>typeof r.document.value.supplyApr==='string'&&typeof r.document.value.variableBorrowApr==='string'));
    assert.equal((await s.pool.query('select * from paper_fills')).rowCount,0);
    assert.equal((await s.pool.query('select * from intents')).rowCount,0);
  });

  test('launch an AI-gated purchase: one run reads, decides, buys through the real executor and notifies', async () => {
    const s = await stack();
    await s.observe('2500');
    const { agentId, request } = await s.draft();
    const op = await s.launch(agentId, request);
    assert.equal(op.status, 202, JSON.stringify(op.json));
    assert.ok(validate('deploymentOperation', op.json).ok);
    assert.equal(op.json.state, 'succeeded');
    const deployment = await s.call('GET', `/agents/${agentId}/deployment`);
    assert.ok(validate('agentDeployment', deployment.json).ok, JSON.stringify(deployment.json));
    assert.equal(deployment.json.desiredState, 'active');

    assert.deepEqual((await s.runtimeStore.tickSchedules()).map((f) => f.reason), ['slot']);
    const report = await s.runtime().cycle();
    assert.equal(report.outcome, 'completed', JSON.stringify(report));
    // The executor filled 25 USD of WETH from the simulation account the launch created.
    const intents = await s.pool.query<{ state: string; settled_input_atomic: string }>('select state, settled_input_atomic from intents');
    assert.deepEqual(intents.rows.map((r) => [r.state, r.settled_input_atomic]), [['settled', '25000000']]);
    const usd = await s.pool.query<{ available: string }>(`select available from simulation_balances where asset_ref = 'paper.USD'`);
    assert.equal(usd.rows[0]!.available, String(1_000_000_000 - 25_000_000));

    assert.ok((await s.runtimeStore.consumeExecutorOutbox()) > 0);
    const runs = await s.call('GET', `/agents/${agentId}/runs`);
    assert.equal(runs.json.items.length, 1);
    assert.ok(validate('runSummary', runs.json.items[0]).ok);
    assert.equal(runs.json.items[0].status, 'completed');
    const detail = await s.call('GET', `/runs/${runs.json.items[0].runId}`);
    assert.ok(validate('runDetail', detail.json).ok, JSON.stringify(detail.json));
    assert.deepEqual(detail.json.operations.map((o: any) => `${o.kind}:${o.outcome}`), ['read:recorded', 'ai.decide:recorded', 'swap.exactInput:settled', 'notify:acknowledged']);
    assert.equal(detail.json.timeline[0].message, 'AI allowed the paper purchase; it settled.');

    const events = await s.call('GET', `/agents/${agentId}/events?limit=100`);
    for (const e of events.json.items) assert.ok(validate('auditEvent2', e).ok, JSON.stringify(e));
    const types = events.json.items.map((e: any) => e.type);
    for (const t of ['deployment.stateChanged', 'run.stateChanged', 'run.step', 'timeline.entry', 'transaction.stateChanged', 'ledger.settled']) assert.ok(types.includes(t), `${t} in ${types}`);
    const sequences = events.json.items.map((e: any) => BigInt(e.sequence));
    assert.deepEqual([...sequences].sort((a, b) => (a < b ? -1 : 1)), sequences, 'ordered by sequence');

    // A contradictory outbox row (failed after settled) is published with the conflict noted, never retried.
    const intent = await s.pool.query<{ tenant_id: string; agent_id: string; id: string; run_id: string; logical_key: string }>('select tenant_id, agent_id, id, run_id, logical_key from intents');
    const i = intent.rows[0]!;
    await s.pool.query(
      `insert into executor_outbox (tenant_id, agent_id, intent_id, run_id, logical_key, type, payload, occurred_at) values ($1, $2, $3, $4, $5, 'transaction.stateChanged', '{"mode":"paper","state":"failed"}', now())`,
      [i.tenant_id, i.agent_id, i.id, i.run_id, i.logical_key],
    );
    assert.equal(await s.runtimeStore.consumeExecutorOutbox(), 1);
    assert.equal(await s.runtimeStore.consumeExecutorOutbox(), 0, 'not retried');
    const conflict = await s.pool.query(`select payload ->> 'conflict' as conflict from audit_events where payload ->> 'state' = 'failed'`);
    assert.equal(conflict.rows[0]!.conflict, 'IDEMPOTENCY_CONFLICT');
  });

  test('the live stream delivers audit events and resumes after Last-Event-ID', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    const read = async (headers: Record<string, string>, want: number) => {
      const controller = new AbortController();
      const response = await fetch(`${s.userOrigin}/v1/agents/${agentId}/stream`, { headers: { cookie: 'me', ...headers }, signal: controller.signal });
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      const reader = response.body!.getReader();
      const ids: string[] = [];
      let text = '';
      while (ids.length < want) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
        for (const match of text.matchAll(/^id: (\d+)$/gm)) if (!ids.includes(match[1]!)) ids.push(match[1]!);
      }
      controller.abort();
      return ids;
    };
    const first = await read({}, 1);
    assert.equal(first.length, 1);
    await s.call('POST', `/agents/${agentId}/pause`, undefined, { 'idempotency-key': 'pause-stream-1' });
    const after = await read({ 'last-event-id': first[0]! }, 1);
    assert.ok(BigInt(after[0]!) > BigInt(first[0]!), 'resumes strictly after the cursor');
  });

  test('retention (#19): a pruned cursor gets a reset on REST and SSE; resuming from it has no gap or duplicate', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    // Three events older than the 30-day retention, written through the stream sequence like any other.
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    for (const n of [1, 2, 3]) {
      const seq = await s.pool.query<{ last_sequence: string }>(
        `insert into tenant_streams (tenant_id, last_sequence) values ($1, 1) on conflict (tenant_id) do update set last_sequence = tenant_streams.last_sequence + 1 returning last_sequence`, [s.tenant]);
      await s.pool.query(
        `insert into audit_events (tenant_id, sequence, agent_id, actor_kind, trace_id, type, payload, occurred_at, source) values ($1, $2, $3, 'controlPlane', $4, 'run.step', '{}', $5, $6)`,
        [s.tenant, seq.rows[0]!.last_sequence, agentId, 'cd'.repeat(16), old, `old-event-${n}`]);
    }
    await s.launch(agentId, request);
    await s.call('POST', `/agents/${agentId}/pause`, undefined, { 'idempotency-key': 'pause-retention' });
    const before = (await s.call('GET', `/agents/${agentId}/events?limit=100`)).json.items.map((e: any) => e.sequence);
    assert.deepEqual(before.slice(0, 3), ['1', '2', '3']);

    assert.deepEqual(await pruneAudit(s.pool, 30), { tenants: 1, removed: 3 });
    const kept = before.slice(3);
    // REST: a cursor inside the pruned range is refused with where to resume; no cursor and the floor both read the rest.
    const expired = await s.call('GET', `/agents/${agentId}/events?after=1`);
    assert.equal(expired.status, 410);
    assert.ok(validate('error', expired.json).ok, JSON.stringify(expired.json));
    assert.equal(expired.json.code, 'CURSOR_EXPIRED');
    assert.equal(expired.json.details.resumeFrom, '3');
    assert.deepEqual((await s.call('GET', `/agents/${agentId}/events?limit=100`)).json.items.map((e: any) => e.sequence), kept);
    assert.deepEqual((await s.call('GET', `/agents/${agentId}/events?after=3&limit=100`)).json.items.map((e: any) => e.sequence), kept);

    // SSE: the reset names the floor (also as its id, so a browser reconnect resumes there) and ends the stream.
    const stream = async (lastEventId: string, until: (text: string) => boolean) => {
      const controller = new AbortController();
      const response = await fetch(`${s.userOrigin}/v1/agents/${agentId}/stream`, { headers: { cookie: 'me', 'last-event-id': lastEventId }, signal: controller.signal });
      const reader = response.body!.getReader();
      let text = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
        if (until(text)) break;
      }
      controller.abort();
      return text;
    };
    const reset = await stream('2', () => false);
    assert.match(reset, /^id: 3\nevent: reset\ndata: \{"code":"CURSOR_EXPIRED","resumeFrom":"3"\}$/m);
    assert.doesNotMatch(reset, /event: audit/);
    const resumed = await stream('3', (text) => [...text.matchAll(/^id: (\d+)$/gm)].length >= kept.length);
    assert.deepEqual([...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]), kept, 'every kept event exactly once');
  });

  test('quota (#17): one running paper agent per user; launch and resume over it are refused with the reason', async () => {
    const s = await stack();
    const a = await s.draft();
    const b = await s.draft('scheduled_purchase');
    assert.equal((await s.launch(a.agentId, a.request)).status, 202);
    const refused = await s.launch(b.agentId, b.request);
    assert.equal(refused.status, 429, JSON.stringify(refused.json));
    assert.ok(validate('error', refused.json).ok, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'LIMIT_EXCEEDED');
    assert.equal(refused.json.details.reason, 'QUOTA_CONCURRENCY');
    assert.match(refused.json.message, /one paper agent|pause or stop/i);
    const quota = await s.call('GET', '/quota');
    assert.ok(validate('paperQuota', quota.json).ok, JSON.stringify(quota.json));
    assert.deepEqual(quota.json.concurrentAgents, { used: 1, limit: 1 });
    assert.equal(quota.json.sessions[0].agentId, a.agentId);
    assert.equal(quota.json.sessionSecondsLimit, 3600);
    // Pausing A frees the slot; then A cannot resume while B runs.
    await s.call('POST', `/agents/${a.agentId}/pause`, undefined, { 'idempotency-key': 'pause-quota-a' });
    const fresh = await s.call('POST', `/agents/${b.agentId}/estimates`, {});
    assert.equal((await s.launch(b.agentId, { ...b.request, estimateId: fresh.json.id })).status, 202);
    const resume = await s.call('POST', `/agents/${a.agentId}/resume`, undefined, { 'idempotency-key': 'resume-quota-a' });
    assert.equal(resume.status, 429);
    assert.equal(resume.json.details.reason, 'QUOTA_CONCURRENCY');
    assert.equal((await s.call('GET', `/agents/${a.agentId}/deployment`)).json.desiredState, 'paused');
  });

  test('quota (#17): two concurrent launches of different agents → exactly one is admitted', async () => {
    const s = await stack();
    const [a, b] = [await s.draft(), await s.draft('scheduled_purchase')];
    const results = await Promise.all([s.launch(a.agentId, a.request), s.launch(b.agentId, b.request)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 429], JSON.stringify(results.map((r) => r.json)));
    const active = await s.pool.query(`select 1 from deployments where desired_state = 'active'`);
    assert.equal(active.rowCount, 1);
  });

  test('quota (#17): the global admission cap and the daily limit refuse launches with their reasons', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    await s.pool.query('update platform_limits set paper_active_global = 0');
    const full = await s.launch(agentId, request);
    assert.equal(full.status, 429);
    assert.equal(full.json.details.reason, 'ADMISSION_FULL');
    assert.equal((await s.call('GET', '/quota')).json.admissionOpen, false);
    await s.pool.query('update platform_limits set paper_active_global = 10, paper_daily_minutes = 0');
    const daily = await s.launch(agentId, request);
    assert.equal(daily.status, 429);
    assert.equal(daily.json.details.reason, 'QUOTA_DAILY');
    assert.match(daily.json.message, /midnight UTC/);
    assert.equal((await s.pool.query('select 1 from deployments')).rowCount, 0, 'a refused launch leaves nothing behind');
  });

  test('quota (#17): a used-up session refuses new runs, the sweep pauses it with the reason, resume is refused', async () => {
    const s = await stack();
    await s.observe();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    const intervals = async () => (await s.pool.query<{ generation: number; open: boolean }>('select generation, ended_at is null as open from paper_active_intervals order by generation')).rows.map((r) => [r.generation, r.open]);
    assert.deepEqual(await intervals(), [[1, true]]);
    // 61 minutes of this session have passed.
    await s.pool.query(`update paper_active_intervals set started_at = now() - interval '61 minutes'`);
    assert.deepEqual((await s.runtimeStore.tickSchedules()).map((f) => f.reason), ['QUOTA_SESSION']);
    assert.equal((await s.pool.query('select 1 from runs')).rowCount, 0, 'no run beyond the session');
    const skipped = await s.pool.query<{ reason: string }>(`select payload ->> 'reasonCode' as reason from audit_events where type = 'observation.skipped'`);
    assert.deepEqual(skipped.rows.map((r) => r.reason), ['QUOTA_SESSION']);
    const paused = await s.runtimeStore.enforcePaperQuotas();
    assert.deepEqual(paused.map((p) => p.reason), ['QUOTA_SESSION']);
    assert.deepEqual(await s.runtimeStore.enforcePaperQuotas(), [], 'a paused deployment is left alone');
    assert.deepEqual(await intervals(), [[1, false]]);
    const event = await s.pool.query<{ payload: { to: string; reasonCode: string }; actor_kind: string }>(`select payload, actor_kind from audit_events where type = 'deployment.stateChanged' order by sequence desc limit 1`);
    assert.deepEqual([event.rows[0]!.payload.to, event.rows[0]!.payload.reasonCode, event.rows[0]!.actor_kind], ['paused', 'QUOTA_SESSION', 'system']);
    const resume = await s.call('POST', `/agents/${agentId}/resume`, undefined, { 'idempotency-key': 'resume-session' });
    assert.equal(resume.status, 429);
    assert.equal(resume.json.details.reason, 'QUOTA_SESSION');
    // Stop and launch again: a new session (the daily allowance still has time left).
    await s.call('POST', `/agents/${agentId}/stop`, undefined, { 'idempotency-key': 'stop-session' });
    const again = await s.call('POST', `/agents/${agentId}/estimates`, {});
    const relaunch = await s.launch(agentId, { ...request, estimateId: again.json.id, policyVersion: again.json.policyVersion });
    assert.equal(relaunch.status, 202, JSON.stringify(relaunch.json));
  });

  test('quota (#17): pause/resume open and close intervals; minutes split at UTC midnight', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.call('POST', `/agents/${agentId}/pause`, undefined, { 'idempotency-key': 'pause-interval' });
    await s.call('POST', `/agents/${agentId}/resume`, undefined, { 'idempotency-key': 'resume-interval' });
    const rows = await s.pool.query<{ generation: number; open: boolean; deployment_id: string }>('select generation, ended_at is null as open, deployment_id from paper_active_intervals order by generation');
    assert.deepEqual(rows.rows.map((r) => [r.generation, r.open]), [[1, false], [2, true]]);
    const deploymentId = rows.rows[0]!.deployment_id;
    // A fixed past day: 23:30 → 00:45 across midnight, then 01:00 → 01:10.
    await s.pool.query(
      `insert into paper_active_intervals (tenant_id, deployment_id, generation, started_at, ended_at) values
       ($1, $2, 10, '2026-01-01T23:30:00Z', '2026-01-02T00:45:00Z'), ($1, $2, 11, '2026-01-02T01:00:00Z', '2026-01-02T01:10:00Z')`, [s.tenant, deploymentId]);
    assert.equal(await dailySeconds(s.pool, s.tenant, new Date('2026-01-01T23:59:00Z')), 29 * 60);
    assert.equal(await dailySeconds(s.pool, s.tenant, new Date('2026-01-02T12:00:00Z')), 55 * 60);
    assert.equal(await dailySeconds(s.pool, s.tenant, new Date('2026-01-02T01:05:00Z')), 50 * 60, 'an interval is counted only up to now');
    assert.equal(await sessionSeconds(s.pool, deploymentId, new Date('2026-01-02T12:00:00Z')), 85 * 60);
  });

  test('quota (#17): a sweep that crosses UTC midnight rechecks under the lock and does not pause for yesterday', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    const deploymentId = (await s.pool.query<{ id: string }>('select id from deployments where agent_id = $1', [agentId])).rows[0]!.id;
    // Three hours used on 2026-01-05 (over the 120-minute day); the session limit is lifted so only the day matters.
    await s.pool.query('update platform_limits set paper_session_minutes = 100000');
    await s.pool.query(`insert into paper_active_intervals (tenant_id, deployment_id, generation, started_at, ended_at) values ($1, $2, 10, '2026-01-05T21:00:00Z', '2026-01-05T23:59:00Z')`, [s.tenant, deploymentId]);
    // The scan reads the clock at 23:59:59; by the time the deployment is locked it is past midnight.
    const clock = ['2026-01-05T23:59:59.000Z'];
    const sweeper = new RuntimeControlStore({ pool: s.pool, now: () => clock.shift() ?? '2026-01-06T00:00:01.000Z' });
    assert.deepEqual(await sweeper.enforcePaperQuotas(), [], "yesterday's allowance does not pause today's agent");
    assert.equal((await s.call('GET', `/agents/${agentId}/deployment`)).json.desiredState, 'active');
    // Still exhausted under the lock (same day): the sweep pauses with the reason.
    const sameDay = new RuntimeControlStore({ pool: s.pool, now: () => '2026-01-05T23:59:59.000Z' });
    assert.deepEqual((await sameDay.enforcePaperQuotas()).map((p) => p.reason), ['QUOTA_DAILY']);
  });

  test('drain-before-stop (#20): stop with an open paper intent stays stopping until the executor settles it', async () => {
    const s = await stack({ dispatchInline: false });
    await s.observe();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.runtimeStore.tickSchedules();
    assert.equal((await s.runtime().cycle()).outcome, 'waiting', 'the swap is admitted and reserved, not yet filled');
    const intent = (await s.pool.query<{ id: string; state: string; request: Record<string, unknown>; deployment_id: string; generation: number; run_id: string }>('select id, state, request, deployment_id, generation, run_id from intents')).rows[0]!;
    assert.equal(intent.state, 'reserved');

    const stop = await s.call('POST', `/agents/${agentId}/stop`, undefined, { 'idempotency-key': 'stop-drain-1' });
    assert.equal(stop.status, 202);
    assert.equal(stop.json.state, 'succeeded');
    const stopping = await s.call('GET', `/agents/${agentId}/deployment`);
    assert.ok(validate('agentDeployment', stopping.json).ok, JSON.stringify(stopping.json));
    assert.deepEqual([stopping.json.desiredState, stopping.json.openIntents], ['stopping', 1]);
    // Stop is idempotent while stopping; pause, resume and a new launch are refused with readable reasons.
    assert.equal((await s.call('POST', `/agents/${agentId}/stop`, undefined, { 'idempotency-key': 'stop-drain-2' })).status, 202);
    for (const kind of ['pause', 'resume']) {
      const refused = await s.call('POST', `/agents/${agentId}/${kind}`, undefined, { 'idempotency-key': `${kind}-while-stopping` });
      assert.equal(refused.status, 409, kind);
      assert.match(refused.json.message, /stopping/, kind);
    }
    const fresh = await s.call('POST', `/agents/${agentId}/estimates`, {});
    const early = await s.launch(agentId, { ...request, estimateId: fresh.json.id, policyVersion: fresh.json.policyVersion });
    assert.equal(early.status, 409);
    assert.match(early.json.message, /still stopping/);

    // The executor refuses a new intent for the stopping deployment, even with an unexpired capability.
    const iat = Math.floor(Date.now() / 1000);
    const token = signCapability({ aud: 'executor', tenantId: s.tenant, agentId, deploymentId: intent.deployment_id, generation: String(intent.generation), mode: 'paper', actions: ['swap.exactInput'], connectors: { 'paper.uniswap': '1.0.1' }, runId: intent.run_id, iat, exp: iat + 60, jti: '019a0000-0000-7000-8000-00000000d001' }, s.secret);
    const other = { ...intent.request, iterationPath: [7] } as Record<string, unknown>;
    other['logicalKey'] = await intentKey({ deploymentId: intent.deployment_id, generation: String(intent.generation), runId: intent.run_id, nodeId: String(other['nodeId']), iterationPath: [7] });
    const refused = await s.executor.service.submit({ authorization: `Bearer ${token}`, idempotencyKey: String(other['logicalKey']), body: JSON.stringify(other) });
    assert.ok('failure' in refused && refused.failure.reason === 'EXECUTOR_STALE_GENERATION', JSON.stringify(refused));

    // Not stopped while the intent is open; the executor cancels the reserved intent, then the finaliser stops it.
    assert.deepEqual(await s.runtimeStore.finaliseStopping(), []);
    await s.executor.service.reconcile();
    const ended = await s.pool.query<{ state: string }>('select state from intents');
    assert.deepEqual(ended.rows.map((r) => r.state), ['cancelled']);
    const holds = await s.pool.query<{ state: string }>('select state from simulation_reservations');
    assert.deepEqual(holds.rows.map((r) => r.state), ['released'], 'the virtual hold is released');
    await s.runtimeStore.consumeExecutorOutbox();
    assert.deepEqual(await s.runtimeStore.finaliseStopping(), [intent.deployment_id]);
    assert.deepEqual(await s.runtimeStore.finaliseStopping(), [], 'finishing is done once');
    assert.equal((await s.call('GET', `/agents/${agentId}/deployment`)).json.desiredState, 'stopped');
    const changes = await s.pool.query<{ payload: Record<string, unknown> }>(`select payload from audit_events where type = 'deployment.stateChanged' order by sequence`);
    assert.deepEqual(changes.rows.map((r) => r.payload['to']), ['active', 'stopping', 'stopped']);
    assert.deepEqual([changes.rows[1]!.payload['reasonCode'], changes.rows[1]!.payload['openIntents']], ['STOP_DRAINING', 1]);
    const again = await s.call('POST', `/agents/${agentId}/estimates`, {});
    assert.equal((await s.launch(agentId, { ...request, estimateId: again.json.id, policyVersion: again.json.policyVersion })).status, 202);
  });

  test('drain-before-stop (#20): with nothing open a stop reaches stopped at once; a crash between the two resumes', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.call('POST', `/agents/${agentId}/stop`, undefined, { 'idempotency-key': 'stop-direct-1' });
    assert.equal((await s.call('GET', `/agents/${agentId}/deployment`)).json.desiredState, 'stopped');
    const changes = await s.pool.query<{ to: string }>(`select payload ->> 'to' as to from audit_events where type = 'deployment.stateChanged' order by sequence`);
    assert.deepEqual(changes.rows.map((r) => r.to), ['active', 'stopping', 'stopped']);
    // A process that died after writing stopping (simulated): the next finaliser tick completes the stop once.
    const second = await s.draft('scheduled_purchase');
    await s.launch(second.agentId, second.request);
    const id = (await s.call('GET', `/agents/${second.agentId}/deployment`)).json.deploymentId as string;
    await s.pool.query(`update deployments set desired_state = 'stopping' where id = $1`, [id]);
    assert.deepEqual(await s.runtimeStore.finaliseStopping(), [id]);
    assert.equal((await s.call('GET', `/agents/${second.agentId}/deployment`)).json.desiredState, 'stopped');
  });

  test('a pending fill releases the runtime; reconcile → outbox → resume completes the run', async () => {
    const s = await stack({ dispatchInline: false });
    await s.observe();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.runtimeStore.tickSchedules();
    assert.equal((await s.runtime().cycle()).outcome, 'waiting');
    assert.equal((await s.runtime().cycle()).disposition, 'none');
    assert.equal(await s.executor.service.reconcile(), 1);
    await s.runtimeStore.consumeExecutorOutbox();
    assert.equal((await s.runtime().cycle()).outcome, 'completed');
    const runs = await s.call('GET', `/agents/${agentId}/runs`);
    assert.equal(runs.json.items[0].status, 'completed');
  });

  test('runtime death after the executor admitted the swap: the outbox resumes the run, one intent', async () => {
    const s = await stack();
    await s.observe();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.runtimeStore.tickSchedules();
    let crashed = false;
    await assert.rejects(s.runtime((point, command) => { if (point === 'after-dispatch' && command.kind === 'swap.exactInput' && !crashed) { crashed = true; throw new Error('simulated process death'); } }).cycle(), /process death/);
    // The runtime never recorded the settlement; the executor's outbox does, and issues a resume.
    await s.runtimeStore.consumeExecutorOutbox();
    assert.equal((await s.runtime().cycle()).outcome, 'completed');
    assert.equal((await s.pool.query('select 1 from intents')).rowCount, 1);
    assert.equal((await s.pool.query('select 1 from paper_fills')).rowCount, 1);
  });

  test('pause revokes mid-run, resume mints a new generation, stop ends it and a new launch is allowed', async () => {
    const s = await stack();
    await s.observe();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.runtimeStore.tickSchedules();
    const paused = await s.runtime(async (point, command) => {
      if (point === 'after-wait' && command.kind === 'ai.decide') await s.call('POST', `/agents/${agentId}/pause`, undefined, { 'idempotency-key': 'pause-mid-run' });
    }).cycle();
    assert.equal(paused.code, 'REVOKED');
    assert.equal((await s.pool.query('select 1 from intents')).rowCount, 0, 'nothing reached the executor');
    const resumed = await s.call('POST', `/agents/${agentId}/resume`, undefined, { 'idempotency-key': 'resume-0001' });
    assert.equal(resumed.status, 202);
    assert.equal((await s.call('GET', `/agents/${agentId}/deployment`)).json.generation, '2');
    assert.deepEqual(await s.runtimeStore.tickSchedules(), [], 'a resume does not re-run the slot the old generation ran');
    assert.equal((await s.call('GET', `/agents/${agentId}/runs`)).json.items[0].status, 'revoked');
    const revoked = await s.pool.query<{ reason: string }>(`select payload ->> 'reasonCode' as reason from audit_events where type = 'run.stateChanged' and payload ->> 'to' = 'revoked'`);
    assert.deepEqual(revoked.rows.map((r) => r.reason), ['GENERATION_REVOKED'], 'a revoked run carries a vocabulary reason');
    const stopped = await s.call('POST', `/agents/${agentId}/stop`, undefined, { 'idempotency-key': 'stop-000001' });
    assert.equal(stopped.status, 202);
    assert.equal((await s.call('GET', `/agents/${agentId}/deployment`)).json.desiredState, 'stopped');
    const again = await s.call('POST', `/agents/${agentId}/estimates`, {});
    const relaunch = await s.launch(agentId, { ...request, estimateId: again.json.id, policyVersion: again.json.policyVersion });
    assert.equal(relaunch.status, 202, JSON.stringify(relaunch.json));
  });

  test('launch is validated: live, unselected connector or model, expired estimate, duplicate launch and key reuse', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    assert.equal((await s.launch(agentId, { ...request, mode: 'live', stepUpApprovalId: '019a0000-0000-7000-8000-000000000099' })).json.code, 'CAPABILITY_DISABLED');
    assert.equal((await s.launch(agentId, { ...request, connectorSelections: [] })).json.code, 'UNSUPPORTED_CAPABILITY');
    assert.equal((await s.launch(agentId, { ...request, modelProfiles: [] })).json.code, 'UNSUPPORTED_CAPABILITY');
    s.skew.millis = 16 * 60_000; // past the 15-minute estimate lifetime
    const stale = await s.launch(agentId, request);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'ESTIMATE_EXPIRED');
    s.skew.millis = 0;
    const fresh = await s.call('POST', `/agents/${agentId}/estimates`, {});
    const ok = { ...request, estimateId: fresh.json.id };
    const first = await s.launch(agentId, ok, 'launch-key-0001');
    const replay = await s.launch(agentId, ok, 'launch-key-0001');
    assert.deepEqual(replay.json, first.json, 'same key and body replays the operation');
    assert.equal((await s.launch(agentId, { ...ok, resourceProfileRef: 'paper-small-v1' }, 'launch-key-0002')).json.code, 'REVISION_CONFLICT', 'one open deployment per agent');
    assert.equal((await s.launch(agentId, { ...ok, networkRef: 'paper-monad', modelProfiles: [] }, 'launch-key-0001')).json.code, 'IDEMPOTENCY_CONFLICT');
  });

  test('catalog resolution (#18): launch compiles against catalog_versions and the manifest pins every row it used', async () => {
    const s = await stack();
    const catalog = await s.call('GET', '/catalog');
    assert.deepEqual(catalog.json.paperVersions, { connectors: { 'paper.aave': '1.1.0', 'paper.curve': '1.1.0', 'paper.kuru': '1.1.0', 'paper.uniswap': '1.2.0' }, modelProfiles: { 'paper.kimi': '1.1.0' } });
    assert.deepEqual(catalog.json.catalog.connectors['paper.uniswap'], JSON.parse(JSON.stringify(marketCatalog.connectors['paper.uniswap'])), 'drafts compile against the newest (market) connector');
    const { agentId, request } = await s.draft();
    assert.equal((await s.launch(agentId, request)).status, 202);
    const { rows } = await s.pool.query<{ manifest: Record<string, any>; catalog_hash: string; connector_versions: Record<string, string> }>(
      'select manifest, catalog_hash, connector_versions from deployments where agent_id = $1', [agentId],
    );
    const manifest = rows[0]!.manifest;
    assert.ok(validate('deploymentManifest2', manifest).ok, JSON.stringify(manifest));
    assert.equal(manifest['catalogHash'], rows[0]!.catalog_hash);
    assert.deepEqual(rows[0]!.connector_versions, { 'paper.uniswap': '1.0.1' });
    const pins = manifest['catalogPins'] as { kind: string; ref: string; version: string; contentHash: string }[];
    for (const pin of pins) {
      const row = await s.pool.query('select 1 from catalog_versions where kind = $1 and ref = $2 and version = $3 and content_hash = $4', [pin.kind, pin.ref, pin.version, pin.contentHash]);
      assert.equal(row.rowCount, 1, `${pin.kind} ${pin.ref}@${pin.version} is a real row`);
    }
    assert.deepEqual(pins.map((p) => `${p.kind}:${p.ref}@${p.version}`), [
      'asset:paper.AUSD@1.0.0', 'asset:paper.MON@1.1.0', 'asset:paper.USD@1.1.0', 'asset:paper.USDC@1.0.0', 'asset:paper.WETH@1.1.0', 'asset:paper.WMON@1.0.0',
      'connector:paper.aave@1.1.0', 'connector:paper.curve@1.1.0', 'connector:paper.kuru@1.1.0', 'connector:paper.uniswap@1.0.1',
      'feed:paper.aave-ausd-usd@1.1.0', 'feed:paper.aave-usdc-usd@1.1.0', 'feed:paper.ausd-usdc@1.1.0', 'feed:paper.weth-usd@1.1.0', 'feed:paper.weth-usd-kuru@1.1.0',
      'modelProfile:paper.kimi@1.1.0', 'network:paper-monad@1.2.0', 'resourceProfile:paper-small-v1@1.0.0',
    ]);
    // The catalog artifact the runtime fetches is the resolved catalog the manifest hashes.
    const artifact = await s.pool.query<{ content_hash: string; body: string }>("select content_hash, body from artifacts where deployment_id = (select id from deployments where agent_id = $1) and kind = 'catalog'", [agentId]);
    assert.equal(artifact.rows[0]!.content_hash, manifest['catalogHash']);
    const body = JSON.parse(artifact.rows[0]!.body);
    assert.deepEqual(body.connectors['paper.uniswap'], JSON.parse(JSON.stringify(syntheticCatalog.connectors['paper.uniswap'])), 'the pinned synthetic connector, not the newest');
    assert.deepEqual(body.reads['paper.uniswap'], JSON.parse(JSON.stringify(syntheticCatalog.reads['paper.uniswap'])));
  });

  test('catalog resolution (#18): disabled, pre-format and live-only versions refuse launch and resume with the reason', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    const disable = (ref: string, version: string, reason: string | null) =>
      s.pool.query('update catalog_versions set disabled_reason = $3 where ref = $1 and version = $2', [ref, version, reason]);
    const refused = async (body: unknown, needle: string) => {
      const response = await s.launch(agentId, body);
      assert.equal(response.status, 422, JSON.stringify(response.json));
      assert.equal(response.json.code, 'UNSUPPORTED_CAPABILITY');
      assert.ok(String(response.json.message).includes(needle), String(response.json.message));
    };
    await refused({ ...request, connectorSelections: [{ ...request.connectorSelections[0], version: '1.0.0' }] }, 'predates the complete catalog format');
    await disable('paper.uniswap', '1.0.1', 'Venue paused for review.');
    await refused(request, 'paper.uniswap@1.0.1 is disabled: Venue paused for review.');
    await disable('paper.uniswap', '1.2.0', 'Pool under review.');
    assert.equal((await s.call('GET', '/catalog')).json.paperVersions.connectors['paper.uniswap'], undefined, 'a disabled version is not offered');
    await disable('paper.uniswap', '1.2.0', null);
    await disable('paper.uniswap', '1.0.1', null);
    // A live-only registry row is invisible to paper resolution even when well formed.
    const live = { networkRef: 'monad-mainnet', capabilities: ['swap.exactInput'], adapterVersion: 'uniswap-v3/1', venue: 'uniswap-v3', actions: ['swap.exactInput'], reads: {} };
    await s.pool.query("insert into catalog_versions (kind, ref, version, modes, content_hash, definition) values ('connector', 'live.uniswap', '1.0.0', '{live}', $1, $2)", [await contentHash(live), live]);
    assert.equal((await s.call('GET', '/catalog')).json.catalog.connectors['live.uniswap'], undefined);
    await refused({ ...request, connectorSelections: [...request.connectorSelections, { ref: 'live.uniswap', version: '1.0.0', capabilities: ['swap.exactInput'] }] }, 'live.uniswap@1.0.0 is not an enabled paper connector');

    assert.equal((await s.launch(agentId, request)).status, 202);
    assert.equal((await s.call('POST', `/agents/${agentId}/pause`, undefined, { 'idempotency-key': 'pause-0000001' })).status, 202);
    await disable('paper.kimi', '1.1.0', 'Model profile withdrawn.');
    const resume = await s.call('POST', `/agents/${agentId}/resume`, undefined, { 'idempotency-key': 'resume-000001' });
    assert.equal(resume.status, 422, JSON.stringify(resume.json));
    assert.equal(resume.json.code, 'UNSUPPORTED_CAPABILITY');
    assert.match(String(resume.json.message), /paper\.kimi@1\.1\.0 was disabled: Model profile withdrawn\./);
    assert.equal((await s.call('GET', `/agents/${agentId}/deployment`)).json.desiredState, 'paused');
    await disable('paper.kimi', '1.1.0', null);
    assert.equal((await s.call('POST', `/agents/${agentId}/resume`, undefined, { 'idempotency-key': 'resume-000002' })).status, 202);
  });

  test('executor capabilities: the exchanged token verifies at the executor; the control bearer never does', async () => {
    const s = await stack();
    const { agentId, request } = await s.draft();
    await s.launch(agentId, request);
    await s.runtimeStore.tickSchedules();
    const offer = await s.control.poll({ schemaVersion: 'assignment-poll/1', runtimeId: 'runtime-stack-1', state: 'ready', waitSeconds: 0 });
    const token = await s.control.executorCapability();
    const claims = verifyCapability(token, s.secret, Math.floor(Date.now() / 1000));
    assert.equal(claims.runId, offer.assignment!.run.runId);
    assert.equal(claims.deploymentId, offer.assignment!.deployment.deploymentId);
    assert.deepEqual(claims.connectors, { 'paper.uniswap': '1.0.1' });
    assert.ok(claims.exp - claims.iat <= 300);
    assert.throws(() => verifyCapability(offer.capability!.bearer, s.secret, Math.floor(Date.now() / 1000)));
  });
});
