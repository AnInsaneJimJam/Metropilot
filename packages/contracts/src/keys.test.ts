// intent-key/1 and operation-key/1 test vectors. Producers (runtime) and consumers (executor, control API)
// must reproduce these exact values; docs/integration/executor.md publishes the first one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, contentHash, intentKey, operationKey } from './index.ts';

const id = {
  deploymentId: '019a0000-0000-7000-8000-000000000202',
  generation: '3',
  runId: '0xb956dcf10050a6ff918cfabf6f09c0a4c21995f3295e4f186101718e5b810e08',
  nodeId: 'buy_weth',
  iterationPath: [] as number[],
};

test('intent-key/1 hashes the JCS identity document', async () => {
  const text = canonicalize({ schemaVersion: 'intent-key/1', ...id });
  assert.equal(
    text,
    '{"deploymentId":"019a0000-0000-7000-8000-000000000202","generation":"3","iterationPath":[],"nodeId":"buy_weth","runId":"0xb956dcf10050a6ff918cfabf6f09c0a4c21995f3295e4f186101718e5b810e08","schemaVersion":"intent-key/1"}',
  );
  assert.equal(await intentKey(id), await contentHash(JSON.parse(text)));
  assert.match(await intentKey(id), /^0x[0-9a-f]{64}$/);
});

test('every identity component changes the intent key', async () => {
  const base = await intentKey(id);
  for (const change of [{ generation: '4' }, { nodeId: 'sell_weth' }, { iterationPath: [0] }, { deploymentId: '019a0000-0000-7000-8000-000000000203' }]) {
    assert.notEqual(await intentKey({ ...id, ...change }), base, JSON.stringify(change));
  }
  assert.notEqual(await intentKey({ ...id, iterationPath: [0, 1] }), await intentKey({ ...id, iterationPath: [1, 0] }));
});

test('a swap operation key is its intent key; other kinds are namespaced', async () => {
  assert.equal(await operationKey('swap.exactInput', id), await intentKey(id));
  const keys = await Promise.all((['read', 'ai.decide', 'notify'] as const).map((kind) => operationKey(kind, id)));
  assert.equal(new Set([...keys, await intentKey(id)]).size, 4);
});

test('rejects malformed identity parts', async () => {
  await assert.rejects(intentKey({ ...id, generation: '03' }), TypeError);
  await assert.rejects(intentKey({ ...id, iterationPath: [-1] }), TypeError);
});

test('published vector', async () => {
  assert.equal(await intentKey(id), VECTOR);
});
const VECTOR = '0xb8f0dade82e733f451a1d1db26f95505adb0830b983a10a316dd8d423a39bc3c'; // independently checked with sha256sum
