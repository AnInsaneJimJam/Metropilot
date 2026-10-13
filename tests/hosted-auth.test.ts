// Hosted sign-in and tenant isolation on real PostgreSQL (issue #16, G3 exit, API-7). Two users sign in through the
// production app with Privy-format tokens (signed here with a throwaway key); user B must not read, write or stream
// anything of user A's. Skips without a reachable DATABASE_URL unless REQUIRE_DB=1.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { PRESETS, syntheticCatalog, workspaceFromStrategy } from '../packages/strategy/src/index.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';
import { createHostedApp, hostedConfig } from '../apps/api/src/hosted.ts';
import { RuntimeControlStore } from '../apps/api/src/runtime-control/store.ts';

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

const ORIGIN = 'https://studio.example';
const APP_ID = 'test-privy-app-0001';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const privyToken = (sub: string, key = keys.privateKey) => {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ iss: 'privy.io', aud: APP_ID, sub, sid: 'sid', iat: now, exp: now + 3600 })}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const budget = { tradingUsdMicros: '1000000000', hostingUsdMicros: '10000000', dataAndAiUsdMicros: '5000000', monReserveAtomic: '1000000000000000000' };

describe('hosted sign-in and tenant isolation', { skip }, () => {
  const dbName = `hosted_${randomBytes(6).toString('hex')}`;
  let pool: pg.Pool;
  let app: ReturnType<typeof createHostedApp>;
  before(async () => {
    await admin!.query(`create database ${dbName}`);
    const url = new URL(process.env['DATABASE_URL']!);
    url.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await migrate(client);
    await seedPaper(client);
    await client.end();
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    pool.on('connect', (c) => c.on('error', () => {}));
    pool.on('error', () => {});
    app = createHostedApp(pool, hostedConfig({
      NODE_ENV: 'production', DATABASE_URL: url.toString(), PUBLIC_ORIGIN: ORIGIN, PRIVY_APP_ID: APP_ID,
      PRIVY_VERIFICATION_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), RUNTIME_IMAGE_DIGEST: '0x' + '5a'.repeat(32),
    }));
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  const login = async (sub: string) => {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { origin: ORIGIN }, payload: { token: privyToken(sub) } });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = String(response.headers['set-cookie']);
    assert.match(cookie, /^__Host-monad_session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
    return cookie.split(';')[0]!;
  };
  const as = (cookie: string) => async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url: `/v1${url}`, headers: { cookie, origin: ORIGIN, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, json: response.body ? (response.json() as Record<string, any>) : {} };
  };
  const key = () => `k-${randomBytes(8).toString('hex')}`;

  test('first sign-in creates one tenant per identity; later sign-ins reuse it; nothing secret is stored', async () => {
    const sub = 'did:privy:cm0firstlogin0001';
    const [a, b] = await Promise.all([login(sub), login(sub)]);
    assert.notEqual(a, b, 'each sign-in is its own session');
    const identities = await pool.query('select tenant_id from identities where subject = $1', [sub]);
    assert.equal(identities.rows.length, 1);
    const sessions = await pool.query<{ tenant_id: string; token_hash: Buffer }>('select tenant_id, token_hash from sessions where subject = $1', [sub]);
    assert.equal(sessions.rows.length, 2);
    for (const row of sessions.rows) {
      assert.equal(row.tenant_id, identities.rows[0].tenant_id);
      assert.ok(!a.includes(row.token_hash.toString('hex')) && !b.includes(row.token_hash.toString('hex')), 'only the hash is stored');
    }
    assert.equal((await as(a)('GET', '/agents')).status, 200);
  });

  test('forged, missing, expired and revoked sessions are 401; a suspended account cannot sign in', async () => {
    const forged = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const refused = await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { origin: ORIGIN }, payload: { token: privyToken('did:privy:cm0forgedlogin001', forged) } });
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.headers['set-cookie'], undefined);
    assert.equal((await pool.query(`select 1 from identities where subject = 'did:privy:cm0forgedlogin001'`)).rows.length, 0);
    assert.equal((await as('')('GET', '/agents')).status, 401);
    assert.equal((await as(`__Host-monad_session=${'ab'.repeat(32)}`)('GET', '/agents')).status, 401);
    // A cookie-shaped header without the __Host- prefix is not the session.
    const cookie = await login('did:privy:cm0sessionends001');
    assert.equal((await as(cookie.replace('__Host-', ''))('GET', '/agents')).status, 401);

    await pool.query(`update sessions set created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' where subject = 'did:privy:cm0sessionends001'`);
    assert.equal((await as(cookie)('GET', '/agents')).status, 401, 'expired');

    const second = await login('did:privy:cm0sessionends001');
    assert.equal((await as(second)('GET', '/agents')).status, 200);
    // The web client sends a JSON content type on every request, including this bodiless one.
    const logout = await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers: { cookie: second, origin: ORIGIN, 'content-type': 'application/json' } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await as(second)('GET', '/agents')).status, 401, 'revoked');

    const third = await login('did:privy:cm0sessionends001');
    await pool.query(`update tenants set state = 'suspended' where id = (select tenant_id from identities where subject = 'did:privy:cm0sessionends001')`);
    assert.equal((await as(third)('GET', '/agents')).status, 401, 'suspended tenants lose open sessions');
    const suspended = await app.inject({ method: 'POST', url: '/v1/auth/session', headers: { origin: ORIGIN }, payload: { token: privyToken('did:privy:cm0sessionends001') } });
    assert.equal(suspended.statusCode, 403);
  });

  test("user B cannot read, write or stream user A's agents, revisions, deployments, runs, operations or events", async () => {
    const alice = as(await login('did:privy:cm0alicetenant01'));
    const bob = as(await login('did:privy:cm0bobtenant0001'));
    const strategy = PRESETS.find((p) => p.id === 'ai_gated_purchase')!.strategy;
    const draft = { schemaVersion: 'control-workspace/1', name: 'Alice', experience: 'rookie', workspace: workspaceFromStrategy(strategy, syntheticCatalog), budget };
    const saved = await alice('POST', '/agents', draft, { 'idempotency-key': key() });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    const agentId = saved.json.id as string;
    const estimate = await alice('POST', `/agents/${agentId}/estimates`, {});
    assert.equal(estimate.status, 200, JSON.stringify(estimate.json));
    const request = {
      schemaVersion: 'deployment/1', agentId, strategyRevisionId: saved.json.revisionId, mode: 'paper', networkRef: 'paper-monad',
      connectorSelections: [{ ref: 'paper.uniswap', version: '1.0.1', capabilities: ['price.read', 'swap.exactInput'] }],
      modelProfiles: [{ ref: 'paper.kimi', version: '1.1.0' }], resourceProfileRef: 'paper-small-v1',
      budgetVersion: estimate.json.budgetVersion, policyVersion: estimate.json.policyVersion, estimateId: estimate.json.id,
    };
    const op = await alice('POST', `/agents/${agentId}/deployments`, request, { 'idempotency-key': key() });
    assert.equal(op.status, 202, JSON.stringify(op.json));
    const runtime = new RuntimeControlStore({ pool });
    const now = new Date().toISOString();
    await runtime.ingestPrice({ sourceEventKey: `obs-${key()}`, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: '2500' }, observedAt: now, receivedAt: now });
    await runtime.tickSchedules();
    const runs = await alice('GET', `/agents/${agentId}/runs`);
    assert.equal(runs.status, 200);
    const runId = runs.json.items[0]?.runId as string;
    assert.ok(runId, 'alice has a run');
    assert.ok((await alice('GET', `/agents/${agentId}/events`)).json.items.length > 0, 'alice has events');

    // Bob sees an empty workspace and a 404 for every one of Alice's objects; nothing of hers changes.
    assert.deepEqual((await bob('GET', '/agents')).json.items, []);
    const attempts: [string, Promise<{ status: number; json: Record<string, any> }>][] = [
      ['save revision', bob('POST', `/agents/${agentId}/strategy-revisions`, draft, { 'idempotency-key': key(), 'if-match': '"1"' })],
      ['estimate', bob('POST', `/agents/${agentId}/estimates`, {})],
      ['launch', bob('POST', `/agents/${agentId}/deployments`, request, { 'idempotency-key': key() })],
      ['pause', bob('POST', `/agents/${agentId}/pause`, undefined, { 'idempotency-key': key() })],
      ['resume', bob('POST', `/agents/${agentId}/resume`, undefined, { 'idempotency-key': key() })],
      ['stop', bob('POST', `/agents/${agentId}/stop`, undefined, { 'idempotency-key': key() })],
      ['operation', bob('GET', `/operations/${op.json.id}`)],
      ['deployment', bob('GET', `/agents/${agentId}/deployment`)],
      ['runs', bob('GET', `/agents/${agentId}/runs`)],
      ['run', bob('GET', `/runs/${runId}`)],
      ['events', bob('GET', `/agents/${agentId}/events`)],
      ['stream', bob('GET', `/agents/${agentId}/stream`)],
    ];
    for (const [label, attempt] of attempts) {
      const { status, json } = await attempt;
      assert.equal(status, 404, `${label}: ${JSON.stringify(json)}`);
      assert.equal(json.code, 'NOT_FOUND', label);
    }
    // A tenant claim in a body is refused, not used.
    const claimed = await bob('POST', '/agents', { ...draft, tenantId: 'x' }, { 'idempotency-key': key() });
    assert.equal(claimed.status, 400);
    assert.equal((await alice('GET', `/agents/${agentId}/deployment`)).json.desiredState, 'active');
    assert.equal((await alice('GET', '/agents')).json.items[0].version, 1);
    // Quotas are per user (#17): Bob's quota shows none of Alice's running agent or time.
    const bobQuota = (await bob('GET', '/quota')).json;
    assert.deepEqual([bobQuota.concurrentAgents.used, bobQuota.dailySeconds.used, bobQuota.sessions], [0, 0, []]);
    assert.equal((await alice('GET', '/quota')).json.sessions[0].agentId, agentId);
  });
});
