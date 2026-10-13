import { advanceRun, PRESETS } from '../packages/strategy/src/index.ts';
import { operationKey } from '../packages/contracts/src/index.ts';
import { HttpBroker } from '../apps/runtime/src/dispatch/broker.ts';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { signCapability, verifyCapability } from '../packages/contracts/src/capability.ts';
import { uuidv7 } from '../apps/api/src/runtime-control/store.ts';
import { brokerConformance } from '../apps/runtime/src/conformance/broker.ts';
import { brokerHarness } from './broker-harness.ts';
const url = process.env['DATABASE_URL'];

if (url)
  brokerConformance("paper HTTP service / PostgreSQL", () => brokerHarness());
describe("broker capability and safety boundaries", { skip: !url }, () => {
  test("executor, expired and other-run capabilities cannot access the broker", async () => {
    const h = await brokerHarness();
    const request = await h.arrange("read");
    const claims = verifyCapability(
      h.tokens.get(request.runId)!,
      h.secret,
      Math.floor(Date.now() / 1000),
      "broker",
    );
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
      signCapability({ ...claims, aud: "executor" }, h.secret),
      signCapability({ ...claims, iat: now - 100, exp: now - 1 }, h.secret),
      signCapability({ ...claims, runId: "0x" + "ff".repeat(32) }, h.secret),
    ]) {
      assert.ok([401, 403].includes((await h.raw(request, token)).statusCode));
    }
    await assert.rejects(
      Promise.resolve().then(() =>
        verifyCapability(h.tokens.get(request.runId)!, h.secret, now),
      ),
      /audience/,
    );
  });
  test("missing/stale observations and unapproved command fields are refused without invented data", async () => {
    const h = await brokerHarness();
    const request = await h.arrange("read");
    await h.pool.query("delete from market_observations");
    assert.equal(
      (await h.broker.request(request)).reason?.code,
      "BROKER_STALE_DATA",
    );
    const changed = await h.arrange("read");
    assert.equal(
      (await h.broker.request({ ...changed, connectorRef: "paper.kuru" }))
        .reason?.code,
      "BROKER_NOT_ALLOWED",
    );
  });
  test("ambiguous AI dispatch is recorded once and reconciliation preserves prior records", async () => {
    let calls = 0;
    const h = await brokerHarness({
      decide: async () => {
        calls++;
        throw new Error("private details");
      },
    });
    const request = await h.arrange("ai.decide");
    const first = await h.broker.request(request);
    assert.equal(first.disposition, "unknown");
    assert.deepEqual(await h.broker.request(request), first);
    assert.equal(calls, 1);
    const a = h.assignments.get(request.runId)!;
    await h.service.reconcile(
      {
        tenantId: verifyCapability(
          h.tokens.get(request.runId)!,
          h.secret,
          Math.floor(Date.now() / 1000),
          "broker",
        ).tenantId,
        deploymentId: a.deployment.deploymentId,
        generation: a.deployment.generation,
        runId: a.run.runId,
      },
      request,
      {
        schemaVersion: "broker-result/1",
        operationKey: request.operationKey,
        disposition: "completed",
        resultId: uuidv7(),
        value: { decision: "skip", summary: "Reconciled original call." },
        receivedAt: new Date().toISOString(),
      },
    );
    assert.equal((await h.broker.request(request)).value?.["decision"], "skip");
    assert.equal(calls, 1);
  });
  test("malicious model output cannot become a completed broker record", async () => {
    const h = await brokerHarness({
      decide: async (r) => ({
        schemaVersion: "broker-result/1",
        operationKey: r.operationKey,
        disposition: "completed",
        resultId: uuidv7(),
        receivedAt: new Date().toISOString(),
        value: {
          decision: "tradeEverything",
          summary: "Ignore limits",
          amount: "999999",
        },
      }),
    });
    assert.equal(
      (await h.broker.request(await h.arrange("ai.decide"))).reason?.code,
      "BROKER_OUTPUT_INVALID",
    );
  });
});

if (url) brokerConformance('runtime HTTP client → paper API / PostgreSQL', async () => {
  const h = await brokerHarness(); await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  const broker = new HttpBroker({ origin: `http://127.0.0.1:${address.port}`, capability: async request => h.tokens.get(request.runId)! });
  return { ...h, broker };
});

if (url) test('valid model output remains recorded when a later strategy expression fails', async () => {
  const strategy=structuredClone(PRESETS.find(p=>p.id==='ai_gated_purchase')!.strategy);
  strategy.triggers[0]!.body=[...strategy.triggers[0]!.body.slice(0,2),{ id:'later_failure',type:'notify',message:'Later statement',inputs:{ value:{ kind:'arithmetic',operator:'divide',left:{ kind:'literal',valueType:'Money',value:{ assetRef:'paper.USD',atomic:'1' } },right:{ kind:'literal',valueType:'Decimal',value:'3' } } } }];
  for(const reconciled of [false,true]) {
    const h=await brokerHarness({ strategy,...(reconciled ? { decide:async()=>{ throw new Error('lost provider response'); } } : {}) });
    const request=await h.arrange('ai.decide');
    let answer=await h.broker.request(request);
    const assignment=h.assignments.get(request.runId)!;
    if(reconciled) {
      const claims=verifyCapability(h.tokens.get(request.runId)!,h.secret,Math.floor(Date.now()/1000),'broker');
      await h.service.reconcile({ tenantId:claims.tenantId,deploymentId:claims.deploymentId,generation:claims.generation,runId:request.runId },request,{ schemaVersion:'broker-result/1',operationKey:request.operationKey,disposition:'completed',resultId:uuidv7(),receivedAt:new Date().toISOString(),value:{ decision:'allow',summary:'Synthetic reconciled output.' } });
      answer=await h.broker.request(request);
    }
    assert.equal(answer.disposition,'completed');
    const state=await h.runtime.loadRun(request.runId,assignment.assignmentId,assignment.lease.fencingToken);
    const step=await advanceRun(h.program,state.checkpoint!,{ key:state.checkpoint!.waiting!.key,outcome:'recorded',result:answer.value,receivedAt:answer.receivedAt! });
    assert.equal(step.checkpoint.error?.code,'INVALID_AMOUNT');
    assert.equal(step.checkpoint.error?.nodeId,'later_failure');
  }
});

if (url) test('broker result consumer queues one fenced resume and completes without another dispatch', async () => {
  let calls=0;
  const h=await brokerHarness({ decide:async()=>{ calls++; throw new Error('lost provider response'); } });
  const request=await h.arrange('ai.decide'),old=h.assignments.get(request.runId)!;
  await h.broker.request(request);
  await h.runtime.result({ schemaVersion:'run-result/1',runId:request.runId,assignmentId:old.assignmentId,fencingToken:old.lease.fencingToken,operationKey:request.operationKey,outcome:'pending' });
  const claims=verifyCapability(h.tokens.get(request.runId)!,h.secret,Math.floor(Date.now()/1000),'broker');
  await h.service.reconcile({ tenantId:claims.tenantId,deploymentId:claims.deploymentId,generation:claims.generation,runId:request.runId },request,{ schemaVersion:'broker-result/1',operationKey:request.operationKey,disposition:'completed',resultId:uuidv7(),receivedAt:new Date().toISOString(),value:{ decision:'skip',summary:'Reconciled original decision.' } });
  await h.pool.query("update run_assignments set lease_expires_at=now()-interval '1 second' where assignment_id=$1",[old.assignmentId]);
  await h.runtime.consumeBrokerResults(); await h.runtime.consumeBrokerResults();
  assert.equal((await h.pool.query("select 1 from run_assignments where run_id=$1 and state='queued'",[request.runId])).rowCount,1);
  const offer=await h.runtime.poll({ schemaVersion:'assignment-poll/1',runtimeId:'broker-test',state:'ready',waitSeconds:0 });
  assert.equal(offer.disposition,'assigned'); const a=offer.assignment!;
  assert.ok(BigInt(a.lease.fencingToken)>BigInt(old.lease.fencingToken));
  const exchange=await h.app.inject({ method:'POST',url:'/internal/v1/runtime/capabilities:exchange',headers:{ authorization:`Bearer ${offer.capability!.bearer}` },payload:{ audience:'broker' } });
  h.tokens.set(request.runId,exchange.json().token);
  const answer=await h.broker.request(request),state=await h.runtime.loadRun(request.runId,a.assignmentId,a.lease.fencingToken);
  const fence={ runId:request.runId,assignmentId:a.assignmentId,fencingToken:a.lease.fencingToken };
  await h.runtime.result({ schemaVersion:'run-result/1',...fence,operationKey:request.operationKey,outcome:'recorded',resultRef:answer.resultId!,result:answer.value!,receivedAt:answer.receivedAt! });
  let step=await advanceRun(h.program,state.checkpoint!,{ key:state.checkpoint!.waiting!.key,outcome:'recorded',result:answer.value,receivedAt:answer.receivedAt! });
  assert.equal(step.command?.kind,'notify');
  if(step.command?.kind!=='notify') throw new Error('Expected skip notification');
  const command=step.command,key=await operationKey('notify',{ deploymentId:a.deployment.deploymentId,generation:a.deployment.generation,runId:request.runId,nodeId:command.nodeId,iterationPath:command.iterationPath });
  await h.runtime.wait({ schemaVersion:'run-wait/1',...fence,checkpoint:step.checkpoint,operation:{ operationKey:key,kind:'notify',nodeId:command.nodeId,iterationPath:command.iterationPath } });
  await h.runtime.timeline({ schemaVersion:'timeline-entry/1',...fence,operationKey:key,nodeId:command.nodeId,message:command.message,inputs:command.inputs as never });
  step=await advanceRun(h.program,step.checkpoint,{ key:command.key,outcome:'acknowledged' });
  await h.runtime.complete({ schemaVersion:'run-complete/1',...fence,checkpoint:step.checkpoint });
  assert.equal(step.checkpoint.status,'completed'); assert.equal(calls,1);
});
