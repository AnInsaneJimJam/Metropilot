import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { BrokerRequest } from '@monad-hack/contracts';
import { HttpBroker } from './broker.ts';
import { RuntimeError } from '../errors.ts';

const request = JSON.parse(readFileSync(new URL('../../../../packages/contracts/fixtures/brokerRequest/valid/read-price.json', import.meta.url), 'utf8')) as BrokerRequest;
const answer = { schemaVersion: 'broker-result/1', operationKey: request.operationKey, disposition: 'pending' };
const isCode = (code: string) => (error: unknown) => error instanceof RuntimeError && error.code === code;

test('network and provider outage retries preserve exact bytes and use new trace IDs', async () => {
  const calls: RequestInit[] = [];
  const broker = new HttpBroker({ origin: 'http://127.0.0.1:4000', capability: async () => 'secret', fetch: async (_url, init) => {
    calls.push(init!);
    if (calls.length === 1) throw new TypeError('lost response');
    return new Response(JSON.stringify(calls.length === 2 ? { requestId: '019a0000-0000-7000-8000-000000000001', code: 'PROVIDER_UNAVAILABLE', message: 'Unavailable', retryable: true } : answer), { status: calls.length === 2 ? 503 : 202 });
  } });
  assert.deepEqual(await broker.request(request), answer);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.body === JSON.stringify(request) && call.redirect === 'error' && call.signal));
  const ids = calls.map(call => (call.headers as Record<string, string>)['x-request-id']);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id!)));
});

test('permanent errors, invalid and oversized responses are never retried', async () => {
  for (const [status, body, code] of [
    [409, JSON.stringify({ requestId: '019a0000-0000-7000-8000-000000000001', code: 'IDEMPOTENCY_CONFLICT', message: 'Conflict', retryable: false }), 'CONFLICT'],
    [401, JSON.stringify({ requestId: '019a0000-0000-7000-8000-000000000001', code: 'UNAUTHENTICATED', message: 'Unauthorized', retryable: false }), 'REVOKED'],
    [500, '{}', 'RESULT_INVALID'], [503, '{}', 'RESULT_INVALID'],
    [500, JSON.stringify({ requestId: '019a0000-0000-7000-8000-000000000001', code: 'INTERNAL_ERROR', message: 'Internal failure', retryable: false }), 'RESULT_INVALID'],
    [200, JSON.stringify({ ...answer, operationKey: '0x' + 'ff'.repeat(32) }), 'RESULT_INVALID'],
    [200, ' '.repeat(65537), 'RESULT_INVALID'],
  ] as const) {
    let calls = 0;
    const broker = new HttpBroker({ origin: 'http://localhost:4000', capability: async () => 'secret', fetch: async () => { calls++; return new Response(body, { status }); } });
    await assert.rejects(broker.request(request), isCode(code));
    assert.equal(calls, 1);
  }
});

test('expired capability refreshes once without changing the operation', async () => {
  let calls = 0; let refreshes = 0;
  const bodies: unknown[] = [];
  const broker = new HttpBroker({ origin: 'http://localhost:4000', capability: async () => `cap-${refreshes}`, forgetCapability: () => { refreshes++; }, fetch: async (_url, init) => {
    bodies.push(init!.body); calls++;
    return new Response(JSON.stringify({ requestId: '019a0000-0000-7000-8000-000000000001', code: 'UNAUTHENTICATED', message: 'Unauthorized', retryable: false }), { status: 401 });
  } });
  await assert.rejects(broker.request(request), isCode('REVOKED'));
  assert.equal(calls, 2); assert.equal(refreshes, 1); assert.equal(bodies[0], bodies[1]);
});

test('deadline abort leaves the operation ambiguous; malformed requests never dispatch', async () => {
  let calls = 0;
  const broker = new HttpBroker({ origin: 'http://localhost:4000', attempts: 1, timeoutMillis: 5, capability: async () => 'secret', fetch: async (_url, init) => {
    calls++;
    await new Promise<void>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('deadline did not abort')), 100);
      init!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init!.signal!.reason); }, { once: true });
    });
    throw new Error('unreachable');
  } });
  await assert.rejects(broker.request(request), isCode('UNAVAILABLE'));
  await assert.rejects(broker.request({ ...request, unexpected: true } as BrokerRequest), isCode('RESULT_INVALID'));
  assert.equal(calls, 1);
  assert.throws(() => new HttpBroker({ origin: 'http://remote.example', capability: async () => '' }), isCode('ASSIGNMENT_INVALID'));
});
