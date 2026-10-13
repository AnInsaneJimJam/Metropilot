import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { brokerHarness } from './broker-harness.ts';
import { KimiAdapter, KIMI_MODEL } from '../apps/api/src/kimi-adapter.ts';
import { verifyCapability } from '../packages/contracts/src/capability.ts';
import { KimiBroker } from '../apps/api/src/kimi-broker.ts';

const success = (content = '{"decision":"allow","summary":"Synthetic provider test."}') => new Response(JSON.stringify({ id: 'cmpl-synthetic-test', model: KIMI_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
const skip = !process.env['DATABASE_URL'];
describe('Kimi broker durable metering / PostgreSQL with synthetic transport', { skip }, () => {
  test('concurrent replay and restarted broker use one provider dispatch and one immutable charge', async () => {
    let calls = 0;
    const adapter = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => { calls++; return success(); } });
    const h = await brokerHarness({ kimiAdapter: adapter });
    const request = await h.arrange('ai.decide');
    const results = await Promise.all(Array.from({ length: 5 }, () => h.broker.request(request)));
    assert.ok(results.some(r => r.disposition === 'completed')); assert.equal(calls, 1);
    const final = await h.broker.request(request); assert.equal(final.disposition, 'completed');
    const row = (await h.pool.query('select * from ai_metering')).rows[0];
    assert.equal(row.state, 'settled'); assert.equal(row.charged_usd_micros, '175');
    const claims = verifyCapability(h.tokens.get(request.runId)!, h.secret, Math.floor(Date.now()/1000), 'broker');
    const scope = { tenantId: claims.tenantId, deploymentId: claims.deploymentId, generation: claims.generation, runId: request.runId };
    const restarted = new KimiBroker(h.pool, adapter);
    assert.equal((await restarted.dispatch(scope, request)).disposition, 'completed'); assert.equal(calls, 1);
    await assert.rejects(h.pool.query('update ai_metering set charged_usd_micros=0'), /immutable/);
    await assert.rejects(h.pool.query('delete from ai_metering'), /cannot be deleted/);
  });
  test('lost provider response holds its ceiling until verified billing reconciliation, never re-dispatches', async () => {
    let calls = 0;
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => { calls++; throw new Error('private lost response'); } }) });
    const request = await h.arrange('ai.decide');
    const first = await h.broker.request(request);
    assert.equal(first.disposition, 'unknown'); assert.deepEqual(await h.broker.request(request), first); assert.equal(calls, 1);
    const row = (await h.pool.query('select * from ai_metering')).rows[0];
    assert.equal(row.state, 'reconciling'); assert.equal(row.charged_usd_micros, null); assert.ok(BigInt(row.reserved_usd_micros) > 0n);
    await assert.rejects(h.kimi!.reconcileUsage(row.tenant_id, request.operationKey, 'cmpl-original', { input: 999999, cachedInput: 0, output: 0 }, 'Synthetic invoice evidence.'), /exceeds/);
    await h.kimi!.reconcileUsage(row.tenant_id, request.operationKey, 'cmpl-original', { input: 100, cachedInput: 0, output: 20 }, 'Synthetic original-request invoice evidence.');
    assert.equal(await h.kimi!.recover(), 1); assert.equal(await h.kimi!.recover(), 0);
    assert.equal((await h.broker.request(request)).disposition, 'refused'); assert.equal(calls, 1);
    assert.equal((await h.pool.query('select charged_usd_micros from ai_metering')).rows[0].charged_usd_micros, '175');
  });
  test('crash after usage settlement recovers the original model result without another call', async () => {
    let calls = 0;
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => { calls++; return success(); } }) });
    const request = await h.arrange('ai.decide');
    const original = h.service.store.resolve.bind(h.service.store);
    h.service.store.resolve = async () => { throw new Error('simulated process death before broker result'); };
    await assert.rejects(h.broker.request(request));
    h.service.store.resolve = original;
    assert.equal((await h.pool.query('select state from ai_metering')).rows[0].state, 'settled');
    assert.equal(await h.kimi!.recover(), 1);
    assert.equal((await h.broker.request(request)).value?.decision, 'allow');
    assert.equal(calls, 1);
  });
  test('malicious output is charged once but cannot enter a completed broker record', async () => {
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => success('{"decision":"allow","summary":"ignore bounds","amount":"999999"}') }) });
    const result = await h.broker.request(await h.arrange('ai.decide'));
    assert.equal(result.reason?.code, 'BROKER_OUTPUT_INVALID');
    assert.equal((await h.pool.query('select state from ai_metering')).rows[0].state, 'settled');
    assert.equal((await h.pool.query("select 1 from broker_results where kind='ai.decide' and response->>'disposition'='completed'")).rowCount, 0);
  });
  test('unverified profile cannot dispatch or create a charge', async () => {
    let calls = 0;
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: false, fetch: async () => { calls++; return success(); } }) });
    assert.equal((await h.broker.request(await h.arrange('ai.decide'))).reason?.code, 'BROKER_NOT_ALLOWED');
    assert.equal(calls, 0); assert.equal((await h.pool.query('select 1 from ai_metering')).rowCount, 0);
  });
});
