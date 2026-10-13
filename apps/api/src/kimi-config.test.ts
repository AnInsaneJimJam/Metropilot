import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { kimiVerified } from './kimi-config.ts';
import { KIMI_MODEL, KIMI_RATES } from './kimi-adapter.ts';

test('Gateway credential alone cannot enable dispatch; evidence pins model, rates and freshness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-gateway-evidence-'));
  const file = join(dir, 'verification.json');
  const now = new Date('2026-10-14T00:00:00Z');
  const evidence = {
    model: KIMI_MODEL, rateVersion: KIMI_RATES.version,
    inputUsdMicrosPerMillion: KIMI_RATES.input.toString(),
    cachedInputUsdMicrosPerMillion: KIMI_RATES.cachedInput.toString(),
    outputUsdMicrosPerMillion: KIMI_RATES.output.toString(),
    boundedBillingVerified: true, verifiedAt: now.toISOString(), evidenceRef: 'synthetic-test-only',
  };
  const env = { AI_GATEWAY_API_KEY: 'synthetic-not-a-provider-key', KIMI_VERIFICATION_FILE: file };
  try {
    assert.equal(kimiVerified({ AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY }), false);
    writeFileSync(file, JSON.stringify(evidence));
    assert.equal(kimiVerified(env, now), true);
    assert.throws(() => kimiVerified({ KIMI_API_KEY: env.AI_GATEWAY_API_KEY, KIMI_VERIFICATION_FILE: file }, now));
    for (const patch of [
      { model: 'kimi-k2.6' }, { cachedInputUsdMicrosPerMillion: '160000' },
      { verifiedAt: '2026-10-06T00:00:00Z' }, { verifiedAt: '2026-10-15T00:00:00Z' },
      { boundedBillingVerified: false }, { unexpected: true },
    ]) {
      writeFileSync(file, JSON.stringify({ ...evidence, ...patch }));
      assert.throws(() => kimiVerified(env, now));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
