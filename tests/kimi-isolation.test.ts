import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('user API and executor refuse model credentials before starting services', () => {
  for (const entry of ['apps/api/src/server.ts', 'apps/executor/src/main.ts']) {
    const child = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, KIMI_API_KEY: 'synthetic-isolation-marker', LOCAL_EXECUTOR: '1', LOCAL_WORKSPACE: '1' } });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Model credentials are restricted to the broker process/);
    assert.ok(!child.stderr.includes('synthetic-isolation-marker'));
  }
});
