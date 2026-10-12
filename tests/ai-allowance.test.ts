import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { contentHash, validate } from '../packages/contracts/src/index.ts';
import type { BrokerRequest } from '../packages/contracts/src/index.ts';
import { verifyCapability } from '../packages/contracts/src/capability.ts';
import { brokerHarness } from './broker-harness.ts';
import { AiAllowance } from '../apps/api/src/ai-allowance.ts';
import { KimiAdapter, KIMI_MODEL } from '../apps/api/src/kimi-adapter.ts';
import { LifecycleService } from '../apps/api/src/lifecycle.ts';
import { Authority, runAssignment } from '../apps/runtime/src/host.ts';
import { systemClock } from '../apps/runtime/src/ports.ts';
import type { ControlApi } from '../apps/runtime/src/ports.ts';
import { Telemetry } from '../apps/runtime/src/telemetry.ts';

const skip = !process.env['DATABASE_URL'];
const response = (decision = 'allow') => new Response(JSON.stringify({ id: 'cmpl-synthetic-quota', model: KIMI_MODEL, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ decision, summary: 'Synthetic allowance test.' }) } }] }));
type Harness = Awaited<ReturnType<typeof brokerHarness>>;
const scopeFor = (h: Harness, request: BrokerRequest) => {
  const c = verifyCapability(h.tokens.get(request.runId)!, h.secret, Math.floor(Date.now()/1000), 'broker');
  return { tenantId: c.tenantId, deploymentId: c.deploymentId, generation: c.generation, runId: request.runId };
};
async function claim(h: Harness, request: BrokerRequest) {
  const scope = scopeFor(h,request);
  await h.pool.query('insert into broker_operations(tenant_id,operation_key,run_id,request_hash,request) values($1,$2,$3,$4,$5)', [scope.tenantId,request.operationKey,request.runId,await contentHash(request),request]);
  return scope;
}
const controlFor = (h: Harness): ControlApi => ({
  poll: async () => { throw new Error('Host does not poll.'); }, fetchArtifact: async () => { throw new Error('Program already verified.'); },
  loadRun: (run,assignment,fence) => h.runtime.loadRun(run,assignment,fence),
  wait: async body => { await h.runtime.wait(body); }, result: async body => { await h.runtime.result(body); },
  complete: async body => { await h.runtime.complete(body); }, timeline: async body => { await h.runtime.timeline(body); },
  heartbeat: async () => { throw new Error('Unused in a single host cycle.'); },
});

describe('paper AI allowance / PostgreSQL', { skip }, () => {
  test('20-call default is atomic across concurrent runs; replay consumes no extra call or charge', async () => {
    let calls = 0;
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => { calls++; return response(); } }) });
    const first = await h.arrange('ai.decide');
    const before = (await h.pool.query('select paper_budget from agents')).rows;
    const initial = await h.broker.request(first);
    for (let i=1; i<19; i++) assert.equal((await h.broker.request(await h.runAgain(first.runId))).disposition, 'completed');
    const remaining = [await h.runAgain(first.runId), await h.runAgain(first.runId)];
    const answers = await Promise.all(remaining.map(r => h.broker.request(r)));
    assert.deepEqual(answers.map(a => a.disposition).sort(), ['completed','refused']);
    assert.equal(answers.find(a => a.disposition==='refused')!.reason!.code, 'BROKER_BUDGET_EXHAUSTED');
    assert.equal(calls,20);
    assert.deepEqual(await h.broker.request(first), initial);
    const totals = (await h.pool.query('select count(*)::int as calls,sum(charged_usd_micros)::text as charged from ai_allowance_reservations')).rows[0];
    assert.deepEqual(totals,{ calls:20,charged:'3500' });
    assert.deepEqual((await h.pool.query('select paper_budget from agents')).rows,before);
    assert.equal((await h.pool.query('select 1 from simulation_balances')).rowCount,0);
  });

  test('migration backfill preserves legacy billed usage and is idempotent', async () => {
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey:'synthetic-not-a-provider-key',verified:true,fetch:async()=>response() }) });
    const request = await h.arrange('ai.decide');
    // Simulate the pre-#9 deployment: the broker/metering existed, allowance rows did not.
    h.service.allowance.reserve = async () => ({ allowed:true });
    await h.broker.request(request);
    assert.equal((await h.pool.query('select 1 from ai_allowance_reservations')).rowCount,0);
    const migration = await readFile(new URL('../apps/api/migrations/0009_ai_allowance_backfill.sql',import.meta.url),'utf8');
    await h.pool.query(migration); await h.pool.query(migration);
    const row=(await h.pool.query('select state,charged_usd_micros from ai_allowance_reservations')).rows;
    assert.deepEqual(row,[{ state:'settled',charged_usd_micros:'175' }]);
  });

  test('daily micro-USD ceiling prevents concurrent overspend and other agents have separate allowances', async () => {
    const h = await brokerHarness(); const first = await h.arrange('ai.decide');
    const second = await h.runAgain(first.runId);
    const scopes = [await claim(h,first),await claim(h,second)];
    const allowance = new AiAllowance(h.pool);
    const answers = await Promise.all([first,second].map((r,i) => allowance.reserve(scopes[i]!,r.operationKey,60000n)));
    assert.equal(answers.filter(a => a.allowed).length,1);
    const denied = answers.find(a => !a.allowed)!;
    assert.ok(!denied.allowed);
    assert.match(denied.message,/USD 0.10/);
    assert.equal((await h.pool.query('select sum(reserved_usd_micros)::text as amount from ai_allowance_reservations')).rows[0].amount,'60000');
    const other = await h.arrange('ai.decide');
    assert.ok((await allowance.reserve(await claim(h,other),other.operationKey,60000n)).allowed);
    const winner = answers[0]!.allowed ? 0 : 1;
    assert.ok((await allowance.reserve(scopes[winner]!,[first,second][winner]!.operationKey,60000n)).allowed);
    await assert.rejects(allowance.reserve(scopes[winner]!,[first,second][winner]!.operationKey,50000n),/cannot change/);
  });

  test('UTC rollover retains unknown holds against the API allocation; late settlement keeps its original day', async () => {
    const h = await brokerHarness(); const first = await h.arrange('ai.decide');
    const scope = await claim(h,first);
    await h.pool.query(`update agents set paper_budget=jsonb_set(paper_budget,'{dataAndAiUsdMicros}','"100000"')`);
    let now = new Date('2026-10-13T23:59:59.000Z');
    const allowance = new AiAllowance(h.pool,()=>now);
    assert.ok((await allowance.reserve(scope,first.operationKey,60000n)).allowed);
    now = new Date('2026-10-14T00:00:01.000Z');
    const second = await h.runAgain(first.runId), next = await claim(h,second);
    assert.equal((await allowance.reserve(next,second.operationKey,60000n)).allowed,false);
    // Synthetic settlement at its original authorization window; no deletion or rolling the old hold forward.
    await h.pool.query(`update ai_allowance_reservations set state='settled',charged_usd_micros=20000,settled_at=$1 where operation_key=$2`,[now,first.operationKey]);
    assert.ok((await allowance.reserve(next,second.operationKey,60000n)).allowed);
    const rows = (await h.pool.query("select to_char(authorized_day,'YYYY-MM-DD') as day,state from ai_allowance_reservations order by authorized_at")).rows;
    assert.deepEqual(rows,[{ day:'2026-10-13',state:'settled' },{ day:'2026-10-14',state:'held' }]);
  });

  test('budget refusal reaches the runtime and user history without a model call or trade', async () => {
    let calls = 0;
    const h = await brokerHarness({ kimiAdapter: new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified:true,fetch:async()=>{ calls++; return response(); } }) });
    const request = await h.arrange('ai.decide');
    const assignment = h.assignments.get(request.runId)!;
    await h.pool.query(`update agents set paper_budget=jsonb_set(paper_budget,'{dataAndAiUsdMicros}','"1"')`);
    const result = await runAssignment({ assignment,program:h.program },{ control:controlFor(h),broker:h.broker,executor:{ submit:async()=>{ throw new Error('Budget failure must never reach executor.'); } },clock:systemClock,telemetry:new Telemetry({ write:()=>{} }),authority:new Authority() });
    assert.equal(result.status,'failed'); assert.equal(calls,0);
    const scope=scopeFor(h,request);
    const lifecycle = new LifecycleService({ pool:h.pool,runtime:h.runtime,runtimeImageDigest:assignment.deployment.runtimeImageDigest });
    const detail = await lifecycle.run(scope.tenantId,request.runId);
    assert.ok(validate('runDetail',detail).ok,JSON.stringify(detail));
    assert.equal((detail.error as { code:string }).code,'BROKER_BUDGET_EXHAUSTED');
    const claims=verifyCapability(h.tokens.get(request.runId)!,h.secret,Math.floor(Date.now()/1000),'broker');
    const list=await lifecycle.runs(scope.tenantId,claims.agentId,10);
    assert.equal((list.items[0]!.error as { code:string }).code,'BROKER_BUDGET_EXHAUSTED');
    assert.equal((await h.pool.query('select 1 from ai_metering')).rowCount,0);
    assert.equal((await h.pool.query('select 1 from intents')).rowCount,0);
  });

  test('runtime death after a billable decision resumes with the original result and one charge', async () => {
    let calls=0;
    const h=await brokerHarness({ kimiAdapter:new KimiAdapter({ apiKey:'synthetic-not-a-provider-key',verified:true,fetch:async()=>{ calls++; return response('skip'); } }) });
    const request=await h.arrange('ai.decide'),assignment=h.assignments.get(request.runId)!;
    const deps={ control:controlFor(h),broker:h.broker,executor:{ submit:async()=>{ throw new Error('Skip must not trade.'); } },clock:systemClock,telemetry:new Telemetry({ write:()=>{} }),authority:new Authority() };
    await assert.rejects(runAssignment({ assignment,program:h.program },{ ...deps,crashAt:point=>{ if(point==='after-dispatch') throw new Error('simulated runtime death'); } }),/runtime death/);
    const resumed=await runAssignment({ assignment,program:h.program },deps);
    assert.equal(resumed.status,'completed'); assert.equal(calls,1);
    assert.deepEqual((await h.pool.query('select count(*)::int as calls,sum(charged_usd_micros)::text as charge from ai_allowance_reservations')).rows[0],{ calls:1,charge:'175' });
  });
});
