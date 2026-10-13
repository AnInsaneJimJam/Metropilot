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
