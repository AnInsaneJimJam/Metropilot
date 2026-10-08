import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineLimits, evaluateAction } from './index.ts';
import type { ActionContext } from './index.ts';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const base: ActionContext = {
  mode: 'paper', deploymentActive: true, connectorEnabled: true, assetsAllowed: true, requestedSlippageBps: 50,
  limits: [{ maxSlippageBps: 300, dailyActionCount: 100 }, { maxSlippageBps: 50, dailyActionCount: 24 }],
  resolvedInputAtomic: 100n, availableInputAtomic: 100n, actionsInWindow: 23,
  valuation: { observedAtMillis: NOW - 60_000, maxAgeSeconds: 60 }, nowMillis: NOW,
};
const codes = (context: Partial<ActionContext>): string[] => {
  const verdict = evaluateAction({ ...base, ...context });
  return verdict.allow ? [] : verdict.denials.map((d) => d.code);
};

test('allows at every limit boundary', () => {
  assert.deepEqual(evaluateAction(base), { allow: true, policyVersion: 'action-policy/1' });
});

test('limits combine by the most restrictive value', () => {
  assert.deepEqual(combineLimits([{ maxSlippageBps: 300, maxInputAtomic: 10n }, { maxSlippageBps: 50 }, { dailyActionCount: 3, maxInputAtomic: 20n }]), { maxSlippageBps: 50, maxInputAtomic: 10n, dailyActionCount: 3 });
  assert.deepEqual(codes({ requestedSlippageBps: 51 }), ['EXECUTOR_SLIPPAGE_EXCEEDED']);
  assert.deepEqual(codes({ limits: [...base.limits, { maxInputAtomic: 99n }] }), ['EXECUTOR_AMOUNT_EXCEEDED']);
});

test('each failing input denies with its stable reason', () => {
  assert.deepEqual(codes({ deploymentActive: false }), ['EXECUTOR_DEPLOYMENT_INACTIVE']);
  assert.deepEqual(codes({ connectorEnabled: false }), ['EXECUTOR_CONNECTOR_DISABLED']);
  assert.deepEqual(codes({ assetsAllowed: false }), ['EXECUTOR_ASSET_NOT_ALLOWED']);
  assert.deepEqual(codes({ resolvedInputAtomic: 0n }), ['EXECUTOR_AMOUNT_EXCEEDED']);
  assert.deepEqual(codes({ resolvedInputAtomic: 101n }), ['EXECUTOR_AMOUNT_EXCEEDED']);
  assert.deepEqual(codes({ actionsInWindow: 24 }), ['EXECUTOR_DAILY_LIMIT_EXCEEDED']);
  assert.deepEqual(codes({ nowMillis: NOW + 1 }), ['EXECUTOR_STALE_OBSERVATION']);
  assert.deepEqual(codes({ valuation: { observedAtMillis: NOW + 1, maxAgeSeconds: 60 } }), ['EXECUTOR_STALE_OBSERVATION']);
});

test('missing context denies instead of defaulting', () => {
  assert.deepEqual(codes({ limits: [] }), ['EXECUTOR_SLIPPAGE_EXCEEDED', 'EXECUTOR_DAILY_LIMIT_EXCEEDED']);
  assert.deepEqual(codes({ valuation: undefined }), ['EXECUTOR_STALE_OBSERVATION']);
});

test('several failures are all reported, first in a stable order', () => {
  assert.deepEqual(codes({ deploymentActive: false, requestedSlippageBps: 9000, valuation: undefined }), ['EXECUTOR_DEPLOYMENT_INACTIVE', 'EXECUTOR_SLIPPAGE_EXCEEDED', 'EXECUTOR_STALE_OBSERVATION']);
});
