import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { BrokerRequest } from '@monad-hack/contracts';
import { KimiAdapter, KIMI_MODEL, usageCost } from './kimi-adapter.ts';
const request = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/brokerRequest/valid/ai-decision.json', import.meta.url), 'utf8')) as BrokerRequest;
export function providerResponse(content = '{"decision":"allow","summary":"Synthetic test."}', patch: Record<string, unknown> = {}) {
  return { id: 'cmpl-synthetic-1', model: KIMI_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 } }, ...patch };
}

test('exact micro-USD rounding and cached input use integer arithmetic', () => {
  assert.equal(usageCost({ input: 100, cachedInput: 10, output: 20 }), 168n);
  assert.equal(usageCost({ input: 1, cachedInput: 0, output: 0 }), 1n);
  assert.throws(() => usageCost({ input: 0, cachedInput: 1, output: 0 }));
});

test('Kimi disabled gate sends no request; enabled call carries fixed model and bounded parameters', async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://api.moonshot.ai/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_completion_tokens, request.maxOutputTokens);
    assert.equal(body.stream, false); assert.equal(body.n, 1); assert.equal(body.tools, undefined);
    assert.equal(init!.redirect, 'error'); assert.ok(init!.signal);
    return new Response(JSON.stringify(providerResponse()));
  };
  const disabled = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: false, fetch: transport });
  assert.equal((await disabled.call(request, disabled.prepare(request))).result.disposition, 'refused');
  assert.equal(calls, 0);
  const enabled = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: transport });
  const answer = await enabled.call(request, enabled.prepare(request));
  assert.equal(answer.result.value?.decision, 'allow'); assert.equal(answer.providerRequestId, 'cmpl-synthetic-1'); assert.equal(calls, 1);
});

test('summary profile is closed; malformed, malicious and truncated outputs cannot complete', async () => {
  for (const raw of [
    providerResponse('{"decision":"allow","summary":"bad","amount":"99999"}'),
    providerResponse('{"decision":"buy","summary":"bad"}'), providerResponse('not JSON'),
    providerResponse('{"decision":"allow","summary":"' + 'x'.repeat(501) + '"}'),
    providerResponse('{}', { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"decision":"allow","summary":"partial"}' } }] }),
  ]) {
    const adapter = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => new Response(JSON.stringify(raw)) });
    const result = await adapter.call(request, adapter.prepare(request));
    assert.equal(result.result.disposition, 'refused'); assert.equal(result.result.reason?.code, 'BROKER_OUTPUT_INVALID'); assert.ok(result.usage, 'invalid output can still be billed');
  }
  const summary = { ...request, outputSchemaRef: 'summary/1' as const };
  const adapter = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => new Response(JSON.stringify(providerResponse('{"summary":"Synthetic summary."}'))) });
  assert.equal((await adapter.call(summary, adapter.prepare(summary))).result.disposition, 'completed');
});

test('timeouts, oversized payloads and unverifiable/over-ceiling bills remain unknown without retries', async () => {
  for (const raw of [providerResponse('{}', { usage: undefined }), providerResponse('{}', { usage: { prompt_tokens: 999999, completion_tokens: 1, total_tokens: 1000000 } }), providerResponse('{}', { model: 'unexpected-model' }), ' '.repeat(65537), undefined]) {
    let calls = 0;
    const adapter = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async () => { calls++; if (raw === undefined) throw new Error('lost private response'); return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw)); } });
    assert.equal((await adapter.call(request, adapter.prepare(request))).result.disposition, 'unknown'); assert.equal(calls, 1);
  }
});

test('provider deadline abort is an unknown bill, never a fabricated failed-free call', async () => {
  const timed = { ...request, timeoutSeconds: 1 };
  const adapter = new KimiAdapter({ apiKey: 'synthetic-not-a-provider-key', verified: true, fetch: async (_url, init) => {
    await new Promise<void>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('missing abort')), 2000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init!.signal!.reason); }, { once: true });
    });
    throw new Error('unreachable');
  } });
  assert.equal((await adapter.call(timed, adapter.prepare(timed))).result.disposition, 'unknown');
});
