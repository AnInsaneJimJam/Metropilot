// Pure executor checks: capability verification, approved-node matching and paper fill arithmetic.
// Database and HTTP scenarios are in tests/executor-paper.test.ts.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { ActionIntent, Strategy } from '@monad-hack/contracts';
import { matchApprovedNode } from './authorization.ts';
import { CapabilityError, signCapability, verifyCapability } from './capability.ts';
import type { Capability } from './capability.ts';
import { computeFill } from './paper.ts';
import type { RecordedQuote } from './paper.ts';

const secret = randomBytes(32);
const NOW = 1_791_460_800;
const claims: Capability = {
  aud: 'executor', tenantId: '019a0000-0000-7000-8000-000000000000', agentId: '019a0000-0000-7000-8000-000000000001',
  deploymentId: '019a0000-0000-7000-8000-000000000202', generation: '3', mode: 'paper', actions: ['swap.exactInput'],
  connectors: { 'paper.uniswap': '1.0.0' }, iat: NOW, exp: NOW + 300, jti: '019a0000-0000-7000-8000-000000000999',
};

test('capability round-trips and rejects tampering, expiry, wrong audience and long lifetimes', () => {
  const token = signCapability(claims, secret);
  assert.deepEqual(verifyCapability(token, secret, NOW + 10), claims);
  assert.throws(() => verifyCapability(token, randomBytes(32), NOW), CapabilityError);
  assert.throws(() => verifyCapability(token, secret, NOW + 300), /expired/);
  assert.throws(() => verifyCapability(token, secret, NOW - 60), /not yet valid/);
  const [header, , signature] = token.split('.');
  const widened = Buffer.from(JSON.stringify({ ...claims, generation: '4' })).toString('base64url');
  assert.throws(() => verifyCapability(`${header}.${widened}.${signature}`, secret, NOW), /signature/);
  assert.throws(() => signCapability({ ...claims, exp: NOW + 301 }, secret), /lifetime/);
  assert.throws(() => signCapability({ ...claims, aud: 'broker' as 'executor' }, secret), /aud/);
  assert.throws(() => signCapability({ ...claims, wallet: '0x00' } as Capability, secret), /wallet/);
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyCapability(`${none}.${token.split('.')[1]}.`, secret, NOW), /HS256/);
});

const strategy: Strategy = {
  schemaVersion: 'strategy/1', id: 's', name: 'match test',
  triggers: [{
    id: 't', type: 'schedule', intervalSeconds: 60, anchorAt: '2026-10-01T00:00:00.000Z',
    body: [
      { id: 'gate', type: 'if', condition: { kind: 'literal', valueType: 'Boolean', value: true }, then: [
        { id: 'loop', type: 'repeat', count: 3, body: [
          { id: 'buy', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.USD', tokenOutRef: 'paper.WETH', amount: { kind: 'fixed', atomic: '5' }, maxSlippageBps: 50 },
        ] },
      ], else: [] },
      { id: 'note', type: 'notify', message: 'done', inputs: {} },
    ],
  }],
  limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 3, maxActiveSecondsPerRun: 60 },
};
const intent = (overrides: Partial<ActionIntent> = {}): ActionIntent => ({
  schemaVersion: 'action-intent/1', logicalKey: '0x' + '00'.repeat(32), runId: '0x' + '01'.repeat(32), nodeId: 'buy', iterationPath: [2],
  connectorRef: 'paper.uniswap', connectorVersion: '1.0.0', action: 'swap.exactInput', tokenInRef: 'paper.USD', tokenOutRef: 'paper.WETH',
  amount: { kind: 'fixed', atomic: '5' }, maxSlippageBps: 30, observationRefs: [], ...overrides,
});

test('matches one approved swap execution and reports branch gating', () => {
  const match = matchApprovedNode(strategy, intent());
  assert.ok(match.ok && match.branchGated && match.node.id === 'buy');
});

test('refuses forged node, iteration, pair, amount and widened slippage', () => {
  for (const forged of [
    { nodeId: 'note' }, { nodeId: 'loop' }, { nodeId: 'missing' }, { iterationPath: [3] }, { iterationPath: [] }, { iterationPath: [0, 0] },
    { tokenOutRef: 'paper.USD' }, { connectorRef: 'paper.kuru' }, { amount: { kind: 'fixed', atomic: '6' } as const }, { maxSlippageBps: 51 },
  ] satisfies Partial<ActionIntent>[]) {
    assert.equal(matchApprovedNode(strategy, intent(forged)).ok, false, JSON.stringify(forged));
  }
});

test('paper fill uses exact floor arithmetic, declared fee/slippage, and refuses below-minimum fills', () => {
  const quote: RecordedQuote = { source: 'test', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD', rateNumerator: 2500n * 10n ** 6n, rateDenominator: 10n ** 18n, observedAt: '2026-10-08T12:00:00.000Z' };
  assert.deepEqual(computeFill(2n * 10n ** 17n, quote, 50), { ok: true, outputAtomic: 498_250_750n, minimumOutputAtomic: 496_007_500n });
  // 5 bps adverse slippage exceeds a 4 bps limit.
  assert.equal(computeFill(2n * 10n ** 17n, quote, 4).ok, false);
  assert.equal(computeFill(1000n, quote, 50).ok, false);
  assert.equal(computeFill(10n ** 18n, { ...quote, rateDenominator: 0n }, 50).ok, false);
});
