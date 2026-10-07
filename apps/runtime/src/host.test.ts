// Runtime host behavior against the in-memory stand-ins (agent-runtime.md section 18, local scope).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRESETS, syntheticCatalog } from '@monad-hack/strategy';
import type { RuntimeAssignment } from '@monad-hack/contracts';
import { parseConfig } from './config.ts';
import { RuntimeError } from './errors.ts';
import { localEnvironment, LOCAL_IMAGE_DIGEST, PAPER_CONNECTOR_VERSIONS } from './local/environment.ts';
import type { LocalOptions } from './local/environment.ts';

const strategy = (id: string) => PRESETS.find((p) => p.id === id)!.strategy;

async function scheduled(options: LocalOptions = {}) {
  const env = localEnvironment({ autoSettle: true, ...options });
  const deployment = await env.control.deploy({ strategy: strategy('ai_gated_purchase'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
  await env.control.tickSchedules();
  const run = () => [...env.control.runs.values()][0]!;
  return { ...env, deployment, run };
}

async function priced(options: LocalOptions = {}) {
  const env = localEnvironment(options);
  const deployment = await env.control.deploy({ strategy: strategy('threshold_sale'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
  const observe = async (sourceEventKey: string, decimal: string) => {
    env.clock.advance(500);
    const at = env.clock.now();
    env.market.price = decimal;
    return env.control.ingestPrice({ sourceEventKey, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal }, observedAt: at, receivedAt: at });
  };
  return { ...env, deployment, observe };
}

/** Take the next queued assignment without running it. */
async function takeAssignment(env: ReturnType<typeof localEnvironment>): Promise<RuntimeAssignment> {
  const offer = await env.control.poll({ schemaVersion: 'assignment-poll/1', runtimeId: 'test', state: 'ready', waitSeconds: 0 });
  assert.equal(offer.disposition, 'assigned');
  return offer.assignment!;
}

describe('price-triggered run (threshold sale)', () => {
  test('2499 → 2501 → 2502 creates exactly one run; pending swap releases the process; settlement resumes it', async () => {
    const env = await priced({ autoSettle: false });
    const reasons = [];
    for (const [i, p] of ['2499', '2501', '2502'].entries()) reasons.push(...(await env.observe(`e${i}`, p)).map((f) => f.reason));
    assert.deepEqual(reasons, ['baseline', 'crossing', 'no-crossing']);
    assert.equal(env.control.runs.size, 1);
    const runtime = env.supervisor();
    assert.equal((await runtime.cycle()).outcome, 'waiting');
    assert.equal(runtime.state, 'idle');
    assert.equal(env.control.timelineRows.length, 0, 'notification cannot run before settlement');
    assert.equal((await runtime.cycle()).disposition, 'none');
    await env.executor.settlePending();
    assert.equal((await runtime.cycle()).outcome, 'completed');
    assert.equal(env.executor.intents.length, 1);
    assert.equal(env.executor.intents[0]!.state, 'settled');
    assert.equal(env.control.timelineRows.length, 1);
    // 10% of 2 WETH, frozen once by the executor against available inventory.
    assert.equal(env.executor.intents[0]!.action.resolvedInputAtomic, (2n * 10n ** 17n).toString());
  });

  test('a duplicate source event cannot create a second run', async () => {
    const env = await priced();
    await env.observe('e1', '2499');
    await env.observe('e2', '2501');
    const again = await env.observe('e2', '2501');
    assert.deepEqual(again.map((f) => f.reason), ['out-of-order']);
    assert.equal(env.control.runs.size, 1);
  });

  test('stage timings come from the trigger record and the runtime (D34)', async () => {
    const env = await priced({ autoSettle: true });
    await env.observe('e1', '2499');
    await env.observe('e2', '2501');
    env.clock.advance(250);
    const report = await env.supervisor().cycle();
    assert.equal(report.timings?.runCreatedToAssignmentReceived, 250);
    assert.equal(typeof report.timings?.verifiedToFirstDispatch, 'number');
  });
});

describe('AI-gated schedule run', () => {
  test('allow: read → ai.decide → swap → notify, one intent', async () => {
    const env = await scheduled();
    assert.equal((await env.supervisor().cycle()).outcome, 'completed');
    assert.deepEqual(env.telemetry.events.filter((e) => e.event === 'operation.result').map((e) => e.kind), ['read', 'ai.decide', 'swap.exactInput', 'notify']);
    assert.equal(env.executor.intents.length, 1);
    assert.equal(env.run().observationRefs.length, 2, 'the read and AI results are cited');
  });

  test('skip: no swap reaches the executor', async () => {
    const env = await scheduled({ decisions: [{ value: { decision: 'skip', summary: 'unsure' } }] });
    assert.equal((await env.supervisor().cycle()).outcome, 'completed');
    assert.equal(env.executor.intents.length, 0);
    assert.equal(env.control.timelineRows[0]!.message, 'AI said skip; no purchase.');
  });

  test('AI timeout fails closed without trading', async () => {
    const env = await scheduled({ decisions: [{ refuse: 'BROKER_TIMEOUT' }] });
    assert.equal((await env.supervisor().cycle()).outcome, 'failed');
    assert.equal(env.run().checkpoint?.error?.code, 'MODEL_OUTPUT_INVALID');
    assert.equal(env.executor.intents.length, 0);
  });

  test('ambiguous AI call waits for reconciliation; a resume never makes a fresh provider call', async () => {
    const env = await scheduled({ decisions: [{ unknown: true }] });
    assert.equal((await env.supervisor().cycle()).outcome, 'waiting');
    const calls = env.broker.providerCalls;
    env.control.reassign(env.run().runId);
    assert.equal((await env.supervisor().cycle()).outcome, 'waiting');
    assert.equal(env.broker.providerCalls, calls);
  });

  test('an ambiguous AI call reconciled by the broker resumes to completion without a second provider call', async () => {
    const env = await scheduled({ decisions: [{ unknown: true }] });
    assert.equal((await env.supervisor().cycle()).outcome, 'waiting');
    const aiKey = env.telemetry.events.find((e) => e.event === 'operation.result' && e.kind === 'ai.decide')!.operationKey!;
    env.broker.resolve(aiKey, { value: { decision: 'allow', summary: 'Reconciled answer.' } });
    env.control.resumeBrokerOperation(env.run().runId);
    assert.equal((await env.supervisor().cycle()).outcome, 'completed');
    assert.equal(env.broker.providerCalls, 2, 'read + the one AI call');
    assert.equal(env.executor.intents.length, 1);
  });

  test('stale read stops the run with STALE_DATA and no intent', async () => {
    const env = await scheduled({ read: () => ({ value: { price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: '2501' }, observedAt: '2026-10-07T11:00:00.000Z' } }) });
    assert.equal((await env.supervisor().cycle()).outcome, 'failed');
    assert.equal(env.run().checkpoint?.error?.code, 'STALE_DATA');
    assert.equal(env.executor.intents.length, 0);
  });

  test('a malformed read value fails closed in the interpreter, not as a default', async () => {
    const env = await scheduled({ read: () => ({ value: { price: 'cheap' } }) });
    assert.equal((await env.supervisor().cycle()).outcome, 'failed');
    assert.equal(env.run().checkpoint?.error?.code, 'STALE_DATA');
  });
});

describe('recovery and identity', () => {
  for (const point of ['after-wait', 'after-dispatch'] as const) {
    test(`process death ${point} resumes with the same key and one effect`, async () => {
      const env = await scheduled();
      let crashed = false;
      await assert.rejects(env.supervisor({ crashAt: (at, command) => { if (at === point && command.kind === 'swap.exactInput' && !crashed) { crashed = true; throw new Error('boom'); } } }).cycle(), /boom/);
      env.control.reassign(env.run().runId);
      assert.equal((await env.supervisor().cycle()).outcome, 'completed');
      assert.equal(env.executor.intents.length, 1);
      assert.equal(env.executor.submissions(env.executor.intents[0]!.logicalKey), point === 'after-wait' ? 1 : 2);
      assert.equal(env.broker.providerCalls, 2, 'read and AI were not repeated against the provider');
      assert.equal(env.control.timelineRows.length, 1);
    });
  }

  test('a duplicate assignment of a finished run creates no new effect', async () => {
    const env = await scheduled();
    await env.supervisor().cycle();
    env.control.reassign(env.run().runId);
    assert.equal((await env.supervisor().cycle()).outcome, 'completed');
    assert.equal(env.executor.intents.length, 1);
    assert.equal(env.broker.providerCalls, 2);
  });

  test('a stale lease cannot commit results', async () => {
    const env = await scheduled();
    const report = await env.supervisor({ crashAt: (at) => { if (at === 'after-wait') env.control.reassign(env.run().runId); } }).cycle();
    assert.equal(report.outcome, 'lost-authority');
    assert.equal(report.code, 'FENCED');
    assert.equal(env.run().operations.values().next().value?.outcome, undefined, 'no result recorded by the stale worker');
  });

  test('pause revokes authority before the next dispatch; nothing reaches the executor', async () => {
    const env = await scheduled();
    const report = await env.supervisor({ crashAt: (at, command) => { if (at === 'after-wait' && command.kind === 'ai.decide') env.control.pause(env.deployment.deploymentId); } }).cycle();
    assert.equal(report.code, 'REVOKED');
    assert.equal(env.executor.intents.length, 0);
  });

  test('a new generation after resume cannot be acted on by the old assignment', async () => {
    const env = await scheduled();
    const stale = await takeAssignment(env);
    env.control.pause(env.deployment.deploymentId);
    env.control.resume(env.deployment.deploymentId);
    const report = await env.supervisor().execute(stale);
    assert.equal(report.code, 'REVOKED');
  });

  test('a refused heartbeat revokes authority mid-run before the next dispatch', async () => {
    const env = await scheduled();
    const slowBroker = { request: async (body: Parameters<typeof env.broker.request>[0]) => { await new Promise((r) => setTimeout(r, 300)); return env.broker.request(body); } };
    const control = new Proxy(env.control, {
      get(target, prop) {
        if (prop === 'heartbeat') return async () => { throw new RuntimeError('REVOKED', 'Heartbeat refused.'); };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const report = await env.supervisor({ config: { ...env.config, heartbeatMillis: 100 }, control, broker: slowBroker }).cycle();
    assert.equal(report.code, 'REVOKED');
    assert.equal(env.broker.providerCalls, 1, 'the in-flight read finished; nothing after it was dispatched');
    assert.equal(env.executor.intents.length, 0);
  });

  test('drain stops new dispatch and ends the serve loop', async () => {
    const env = await scheduled();
    const runtime = env.supervisor({ crashAt: (at) => { if (at === 'after-wait') runtime.drain(); } });
    const report = await runtime.cycle();
    assert.equal(report.code, 'DRAINING');
    assert.equal(env.broker.providerCalls, 0);
    env.control.drainRuntimes();
    const idle = env.supervisor();
    await idle.serve();
    assert.equal(idle.state, 'stopped');
  });
});

describe('assignment verification fails before the interpreter runs', () => {
  const tamper = async (change: (a: RuntimeAssignment) => void, env?: Awaited<ReturnType<typeof scheduled>>) => {
    const e = env ?? (await scheduled());
    const assignment = await takeAssignment(e);
    change(assignment);
    const report = await e.supervisor().execute(assignment);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.code, 'ASSIGNMENT_INVALID');
    assert.equal(e.broker.providerCalls, 0);
    assert.equal(e.run().checkpoint, undefined);
  };
  test('wrong image digest', () => tamper((a) => { a.deployment.runtimeImageDigest = '0x' + '00'.repeat(32); }));
  test('live deployment on a paper runtime', () => tamper((a) => { a.deployment.mode = 'live'; }));
  test('strategy hash mismatch', () => tamper((a) => { a.artifacts.strategyHash = '0x' + '11'.repeat(32); }));
  test('expired assignment', async () => { const env = await scheduled(); env.clock.advance(61_000); await tamper(() => {}, env); });
  test('unknown fields or versions', () => tamper((a) => { (a as unknown as Record<string, unknown>)['databaseUrl'] = 'postgres://x'; }));
  test('connector without a pinned version', () => tamper((a) => { a.deployment.connectorVersions = {}; }));
});

describe('service answers are checked at the boundary', () => {
  test('a malformed broker answer is rejected, never passed to the interpreter', async () => {
    const env = await scheduled();
    const broker = { request: async () => ({ schemaVersion: 'broker-result/1', operationKey: 'nope', disposition: 'completed' }) as never };
    const report = await env.supervisor({ broker }).cycle();
    assert.equal(report.code, 'RESULT_INVALID');
    assert.equal(env.run().operations.values().next().value?.outcome, undefined);
  });

  test('the executor rejects a logical key that does not match the authenticated identity', async () => {
    const env = await scheduled();
    const executor = { submit: async (intent: Parameters<typeof env.executor.submit>[0]) => env.executor.submit({ ...intent, logicalKey: '0x' + '99'.repeat(32) }) };
    const report = await env.supervisor({ executor }).cycle();
    assert.equal(report.code, 'CONFLICT');
    assert.equal(env.executor.intents.length, 0);
  });

  test('the paper executor never accepts a live run identity', async () => {
    const env = await scheduled();
    const executor = { submit: async (intent: Parameters<typeof env.executor.submit>[0]) => {
      const real = env.control.authorityFor(intent.runId)!;
      Object.assign(env.control.deployments.get(real.deploymentId)!, { mode: 'live' });
      return env.executor.submit(intent);
    } };
    const report = await env.supervisor({ executor }).cycle();
    assert.equal(report.code, 'REVOKED');
    assert.equal(env.executor.intents.length, 0);
  });
});

describe('configuration and telemetry', () => {
  const base = { RUNTIME_ID: 'runtime-1', RUNTIME_MODE: 'paper', RUNTIME_IMAGE_DIGEST: LOCAL_IMAGE_DIGEST };
  test('accepts the closed configuration', () => assert.equal(parseConfig(base).heartbeatMillis, 10_000));
  test('refuses credential-shaped variables and names them without values', () => {
    for (const name of ['DATABASE_URL', 'PRIVY_APP_SECRET', 'KIMI_API_KEY', 'AWS_ACCESS_KEY_ID', 'SESSION_TOKEN']) {
      assert.throws(() => parseConfig({ ...base, [name]: 'hunter2' }), (error: RuntimeError) => error.message.includes(name) && !error.message.includes('hunter2'));
    }
  });
  test('telemetry carries identities and codes only', async () => {
    const env = await scheduled();
    await env.supervisor().cycle();
    const text = JSON.stringify(env.telemetry.events);
    assert.ok(!text.includes('capability:'), 'no capability references');
    assert.ok(!text.includes('steady accumulation'), 'no prompt or model text');
  });
});
