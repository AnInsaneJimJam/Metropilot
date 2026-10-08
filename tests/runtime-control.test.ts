// Runtime ⇄ control API integration on real PostgreSQL (TEST-2, INT-1): the runtime's control API conformance
// kit against the Postgres store directly, then through the internal HTTP API and the runtime's HTTP client,
// then end-to-end paper runs with crash recovery, fencing and revocation. Synthetic paper data only.
// Skips without a reachable DATABASE_URL unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import pg from 'pg';
import { compileStrategy, PRESETS, syntheticCatalog } from '../packages/strategy/src/index.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { RunControlError, RuntimeControlStore, uuidv7 } from '../apps/api/src/runtime-control/store.ts';
import { createInternalApp } from '../apps/api/src/runtime-control/app.ts';
import { controlApiConformance } from '../apps/runtime/src/conformance/control-api.ts';
import { HttpControlApi } from '../apps/runtime/src/dispatch/control-api.ts';
import { runtimeErrorFor } from '../apps/runtime/src/dispatch/errors.ts';
import type { ControlApi } from '../apps/runtime/src/ports.ts';
import { systemClock } from '../apps/runtime/src/ports.ts';
import { Supervisor } from '../apps/runtime/src/supervisor.ts';
import { Telemetry } from '../apps/runtime/src/telemetry.ts';
import { PaperExecutor } from '../apps/runtime/src/local/paper-executor.ts';
import { ScriptedBroker } from '../apps/runtime/src/local/scripted-broker.ts';
import type { ScriptAnswer } from '../apps/runtime/src/local/scripted-broker.ts';
import { LOCAL_IMAGE_DIGEST, PAPER_CONNECTOR_VERSIONS } from '../apps/runtime/src/local/environment.ts';

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

// One migrated template; every harness gets its own database cloned from it, so queues never mix.
const databases: string[] = [];
const pools: pg.Pool[] = [];
let template: Promise<string> | undefined;
const urlFor = (name: string): string => { const url = new URL(process.env['DATABASE_URL']!); url.pathname = `/${name}`; return url.toString(); };
async function freshPool(): Promise<pg.Pool> {
  template ??= (async () => {
    const name = `runtime_tpl_${randomBytes(5).toString('hex')}`;
    await admin!.query(`create database ${name}`);
    databases.push(name);
    const client = new pg.Client({ connectionString: urlFor(name) });
    await client.connect();
    await migrate(client);
    await client.end();
    return name;
  })();
  const name = `runtime_${randomBytes(6).toString('hex')}`;
  await admin!.query(`create database ${name} template ${await template}`);
  databases.push(name);
  const pool = new pg.Pool({ connectionString: urlFor(name), max: 8 });
  // pool.end() resolves before idle sockets close; the forced drop below may kill them (see app.test.ts).
  pool.on('connect', (client) => client.on('error', () => {}));
  pool.on('error', () => {}); // idle-client errors are re-emitted here (see app.test.ts)
  pools.push(pool);
  return pool;
}
after(async () => {
  for (const pool of pools) await pool.end();
  for (const name of databases.reverse()) await admin?.query(`drop database if exists ${name} with (force)`);
  await admin?.end();
});

const preset = (id: string) => PRESETS.find((p) => p.id === id)!.strategy;

/** Tenant, agent and immutable revision for a preset, then a running paper deployment. */
async function deployPreset(pool: pg.Pool, store: RuntimeControlStore, presetId: string): Promise<string> {
  const tenantId = uuidv7();
  const agentId = uuidv7();
  const revisionId = uuidv7();
  const program = await compileStrategy(JSON.stringify(preset(presetId)), syntheticCatalog);
  await pool.query('insert into tenants (id, auth_subject) values ($1, $2)', [tenantId, `test:${tenantId}`]);
  await pool.query('insert into agents (tenant_id, id, name) values ($1, $2, $3)', [tenantId, agentId, presetId]);
  await pool.query(
    `insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation)
     values ($1, $2, $3, 'strategy/1', $4, $5, '{}')`,
    [tenantId, revisionId, agentId, program.hash, program.strategy],
  );
  const { deploymentId } = await store.deploy({ tenantId, agentId, strategyRevisionId: revisionId, mode: 'paper', catalog: syntheticCatalog, connectorVersions: PAPER_CONNECTOR_VERSIONS, runtimeImageDigest: LOCAL_IMAGE_DIGEST });
  return deploymentId;
}

/** In-process ControlApi over the store, mapping its error-1 codes exactly as the HTTP client does. */
function asControlApi(store: RuntimeControlStore): ControlApi {
  const map = <A extends unknown[], R>(call: (...args: A) => Promise<R>, kind: 'artifact' | 'other' = 'other') => async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof RunControlError) throw runtimeErrorFor(error.status, error.code, kind);
      throw error;
    }
  };
  return {
    poll: map((r) => store.poll(r)),
    fetchArtifact: map((ref) => store.fetchArtifact(ref), 'artifact'),
    loadRun: map((runId, assignmentId, token) => store.loadRun(runId, assignmentId, token)),
    wait: map((b) => store.wait(b)),
    result: map((b) => store.result(b)),
    complete: map((b) => store.complete(b)),
    timeline: map((b) => store.timeline(b)),
    heartbeat: map(async (id, token) => { await store.heartbeat(id, token); }),
  };
}

/** The internal API on an ephemeral loopback port, with the runtime's HTTP client pointed at it. */
async function httpStack(store: RuntimeControlStore, runtimeId = 'runtime-test-1') {
  const app = createInternalApp({ store, authenticateWorkload: (headers) => (typeof headers['x-runtime-workload'] === 'string' ? headers['x-runtime-workload'] : undefined), pollIntervalMillis: 20 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  after(() => app.close());
  const client = new HttpControlApi({ origin: `http://127.0.0.1:${port}`, workload: { 'x-runtime-workload': runtimeId } });
  return { app, client };
}


if (skip) describe('control API conformance on PostgreSQL', { skip }, () => {});
else {
  controlApiConformance('RuntimeControlStore on PostgreSQL', async () => {
    const pool = await freshPool();
    const store = new RuntimeControlStore({ pool });
    return {
      api: asControlApi(store),
      clock: systemClock,
      arrangeRun: async () => { await deployPreset(pool, store, 'ai_gated_purchase'); await store.tickSchedules(); },
      expireLease: (runId) => store.reassign(runId),
      timelineCount: (runId) => store.timelineCount(runId),
    };
  });

  controlApiConformance('HTTP client → internal API → PostgreSQL', async () => {
    const pool = await freshPool();
    const store = new RuntimeControlStore({ pool });
    const { client } = await httpStack(store, 'conformance');
    return {
      api: client,
      clock: systemClock,
      arrangeRun: async () => { await deployPreset(pool, store, 'ai_gated_purchase'); await store.tickSchedules(); },
      expireLease: (runId) => store.reassign(runId),
      timelineCount: (runId) => store.timelineCount(runId),
    };
  });
}

/** A full paper stack: Postgres store, internal HTTP API, runtime HTTP client, scripted broker, paper executor. */
async function paperStack(options: { autoSettle?: boolean; decisions?: ScriptAnswer[] } = {}) {
  const pool = await freshPool();
  // The store's clock can be skewed forward to expire leases deterministically.
  const skew = { millis: 0 };
  const store = new RuntimeControlStore({ pool, now: () => new Date(Date.now() + skew.millis).toISOString() });
  const { client } = await httpStack(store);
  const decisions = [...(options.decisions ?? [])];
  const broker = new ScriptedBroker({
    clock: systemClock,
    read: () => ({ value: { price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: '2501' }, observedAt: systemClock.now() } }),
    decide: () => decisions.shift() ?? { value: { decision: 'allow', summary: 'Synthetic AI: allow.' } },
  });
  // The executor's capability check reads authoritative state; the port resolves it before each submit.
  const authorities = new Map<string, Awaited<ReturnType<RuntimeControlStore['authorityFor']>>>();
  const executor = new PaperExecutor({
    clock: systemClock,
    authorityFor: (runId) => authorities.get(runId),
    balances: new Map([['paper.WETH', 2n * 10n ** 18n], ['paper.USD', 10_000n * 10n ** 6n]]),
    fill: (_intent, input) => input / 1_000_000_000n,
    autoSettle: options.autoSettle ?? true,
    onSettled: async (intent, result) => store.settleOperation(intent.runId, intent.logicalKey, result.state === 'settled' ? 'settled' : 'failed', result.intentId),
  });
  const executorPort = { submit: async (intent: Parameters<PaperExecutor['submit']>[0]) => { authorities.set(intent.runId, await store.authorityFor(intent.runId)); return executor.submit(intent); } };
  const config = { runtimeId: 'runtime-test-1', mode: 'paper' as const, imageDigest: LOCAL_IMAGE_DIGEST, heartbeatMillis: 10_000, pollWaitSeconds: 0 };
  const supervisor = (crashAt?: ConstructorParameters<typeof Supervisor>[0]['crashAt']) =>
    new Supervisor({ config, control: client, broker, executor: executorPort, clock: systemClock, telemetry: new Telemetry(), ...(crashAt ? { crashAt } : {}) });
  const runs = async () => (await pool.query<{ run_id: string; status: string; checkpoint: { status: string; error?: { code: string } } | null }>('select run_id, status, checkpoint from runs')).rows;
  return { pool, store, client, broker, executor, supervisor, runs, skew };
}

describe('paper runs end to end over HTTP and PostgreSQL', { skip }, () => {
  test('AI-gated schedule run: read → AI → swap → notify, one intent, timeline once', async () => {
    const s = await paperStack();
    await deployPreset(s.pool, s.store, 'ai_gated_purchase');
    await s.store.tickSchedules();
    const report = await s.supervisor().cycle();
    assert.equal(report.outcome, 'completed', JSON.stringify(report));
    const [run] = await s.runs();
    assert.equal(run!.status, 'completed');
    assert.equal(s.executor.intents.length, 1);
    assert.equal(await s.store.timelineCount(run!.run_id), 1);
  });

  test('price crossing fans out to one run; a duplicate event creates none', async () => {
    const s = await paperStack();
    await deployPreset(s.pool, s.store, 'threshold_sale');
    const observe = async (key: string, decimal: string) => {
      const now = new Date().toISOString();
      return s.store.ingestPrice({ sourceEventKey: key, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal }, observedAt: now, receivedAt: now });
    };
    assert.deepEqual((await observe('e1', '2499')).map((f) => f.reason), ['baseline']);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual((await observe('e2', '2501')).map((f) => f.reason), ['crossing']);
    assert.deepEqual((await observe('e2', '2501')).map((f) => f.reason), ['out-of-order']);
    assert.equal((await s.runs()).length, 1);
    assert.equal((await s.supervisor().cycle()).outcome, 'completed');
  });

  test('a pending swap releases the runtime; settlement records it and the resume completes the run', async () => {
    const s = await paperStack({ autoSettle: false });
    await deployPreset(s.pool, s.store, 'ai_gated_purchase');
    await s.store.tickSchedules();
    assert.equal((await s.supervisor().cycle()).outcome, 'waiting');
    assert.equal((await s.supervisor().cycle()).disposition, 'none');
    await s.executor.settlePending();
    assert.equal((await s.supervisor().cycle()).outcome, 'completed');
    assert.equal(s.executor.intents.length, 1);
  });

  test('process death after dispatch: the lease expires, a replacement resumes with the same key, one effect', async () => {
    const s = await paperStack();
    await deployPreset(s.pool, s.store, 'ai_gated_purchase');
    await s.store.tickSchedules();
    let crashed = false;
    await assert.rejects(s.supervisor((point, command) => { if (point === 'after-dispatch' && command.kind === 'swap.exactInput' && !crashed) { crashed = true; throw new Error('simulated process death'); } }).cycle(), /process death/);
    s.skew.millis = 60_000; // the 30 s lease is now expired, and nothing heartbeats it
    assert.equal((await s.store.reclaimExpiredLeases()).length, 1);
    s.skew.millis = 0;
    assert.equal((await s.supervisor().cycle()).outcome, 'completed');
    assert.equal(s.executor.intents.length, 1);
    assert.equal(s.executor.submissions(s.executor.intents[0]!.logicalKey), 2);
    assert.equal(s.broker.providerCalls, 2, 'read and AI were not repeated against the provider');
  });

  test('pause then resume revokes the waiting run; a late settlement never revives it', async () => {
    const s = await paperStack({ autoSettle: false });
    const deploymentId = await deployPreset(s.pool, s.store, 'ai_gated_purchase');
    await s.store.tickSchedules();
    assert.equal((await s.supervisor().cycle()).outcome, 'waiting');
    await s.store.pause(deploymentId);
    assert.equal(await s.store.resume(deploymentId), 2);
    await s.executor.settlePending();
    assert.equal((await s.runs())[0]!.status, 'revoked');
    assert.equal((await s.supervisor().cycle()).disposition, 'none');
  });

  test('a paused deployment refuses the runtime mid-run before the next dispatch', async () => {
    const s = await paperStack();
    const deploymentId = await deployPreset(s.pool, s.store, 'ai_gated_purchase');
    await s.store.tickSchedules();
    const report = await s.supervisor(async (point, command) => { if (point === 'after-wait' && command.kind === 'ai.decide') await s.store.pause(deploymentId); }).cycle();
    assert.equal(report.code, 'REVOKED');
    assert.equal(s.executor.intents.length, 0);
  });

  test('drain is answered on the next poll', async () => {
    const s = await paperStack();
    await s.store.drainRuntime('runtime-test-1');
    const runtime = s.supervisor();
    await runtime.serve();
    assert.equal(runtime.state, 'stopped');
  });

  test('the internal API refuses unauthenticated workloads, foreign capabilities and other runs', async () => {
    const s = await paperStack();
    await deployPreset(s.pool, s.store, 'ai_gated_purchase');
    await s.store.tickSchedules();
    const origin = (s.client as unknown as { origin: string }).origin;
    const anonymous = await fetch(`${origin}/internal/v1/runtime/assignments:poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 'assignment-poll/1', runtimeId: 'x', state: 'ready', waitSeconds: 0 }) });
    assert.equal(anonymous.status, 401);
    const offer = await s.client.poll({ schemaVersion: 'assignment-poll/1', runtimeId: 'runtime-test-1', state: 'ready', waitSeconds: 0 });
    const runId = offer.assignment!.run.runId;
    const noBearer = await fetch(`${origin}/internal/v1/runs/${runId}?assignmentId=${offer.assignment!.assignmentId}&fencingToken=1`);
    assert.equal(noBearer.status, 401);
    const otherRun = await fetch(`${origin}/internal/v1/runs/0x${'ab'.repeat(32)}?assignmentId=${offer.assignment!.assignmentId}&fencingToken=1`, { headers: { authorization: `Bearer ${offer.capability!.bearer}` } });
    assert.equal(otherRun.status, 403);
  });
});
